---
name: qivo
description: Use Qivo to find, create, update, plan and receive events for project tasks through MCP, REST, or the website. Applies to operating Qivo, not developing its source code.
---

# Using Qivo

Qivo organizes work into projects, sub-projects, and tasks for people and AI
agents. The website, MCP tools, REST routes and exports use task terminology.

Use this guide for the user's requested work. Start with
[authentication and connection setup](https://qivo.io/auth.md) when access is
missing, or [the documentation index](https://qivo.io/llms.txt) for more context.

For a new connection on behalf of a person, prefer **OAuth**. Add
`https://api.qivo.io/mcp` as a remote MCP server in their assistant, then have
the person sign in to Qivo and approve the displayed organization and access.
The client receives and manages its credentials; no manual token is needed.
Use a personal token as a fallback when the client lacks compatible OAuth
support, or when the user explicitly requests it. An agent key is for
automation acting as a named agent user. REST accepts personal tokens and
agent keys. Use an existing working connection for the requested task.

If Microsoft work or school sign-in shows **Need admin approval**, direct the
user and their Microsoft administrator to
[Microsoft sign-in and administrator approval](https://qivo.io/docs/microsoft-sign-in-and-administrator-approval/)
for Qivo's organization approval link. Resume connection setup after the
administrator grants consent. Microsoft approval does not grant Qivo project
access or replace the person's approval of the assistant's connection.

## Learn who you are first

Call `get_me` over MCP, or `GET /v1/me` over REST, before other work. It
returns your user and organization role, the organization's calendar
settings, its upload limit per file, whether you may create projects,
whether billing has paused changes, and what this credential may do:

- `credential.access` is `write` when the credential can make changes and
  `read` when it can only read. Do not plan changes with a read-only
  credential. A person chooses a personal token's access and optional expiry
  when creating it, and neither can change. If the work needs changes, ask
  for a new token created with **Allow changes**.
- `billing.read_only: true` means changes are refused until an
  organization admin restores billing, or while the organization waits for
  its deletion; `billing.reason` says which. An organization admin can still
  remove someone's project or team access with `on_held_tasks: "leave"`.
- `organization.week_start` is the first day of every planning week, `0`
  (Sunday) through `6` (Saturday). `organization.slug` is the organization's
  part of browser links.

Changing a task also needs User or Lead access on its project, and changing a
project's settings needs Lead access. Following a task, your inbox and your
own comments need only read access to the task.

## Choose the interface

- **Connected MCP:** Prefer it for routine task discovery, edits, moves,
  subtasks, links, labels, attachments, comments, the inbox, following and
  archive/restore. The endpoint is
  `https://api.qivo.io/mcp`. Use the client's discovered tools and current
  `tools/list` schemas for arguments. `list_tasks` defaults to 50 results and
  allows at most 200; page active lists with `offset` until a shorter page
  arrives. Archived tasks need `project` and page with `cursor`; pass back
  `next_cursor` until it is null. A tool refuses an argument it does not
  know and names it. Refresh the tool list and retry with current names.
- **REST:** Use `https://api.qivo.io/v1` with an agent key or a personal
  token for scripts, large paginated reads or setting someone's plannable
  hours (`PATCH /v1/users/{id}`, an organization admin or team leader's
  token). A personal token acts as its person and its writes appear under
  their name. OAuth tokens work only on the REST webhook management routes,
  not these task and project routes.
  `GET /v1/tasks?project=<ref>&limit=200&offset=0` returns an
  array; increment `offset` by the page size until a shorter page arrives.
  `archived=true` needs `project` and returns `{next_cursor, tasks}`; pass
  `next_cursor` back as `cursor` until it is null, even after an empty page.
- **Browser:** Use it for the actions under
  [Stays in the app](#stays-in-the-app), which no MCP tool or REST route
  offers. Enter at `https://qivo.io/app` and use the user's signed-in
  session. Follow an explicitly requested interface when it supports the
  work.

Task operations use these names (REST paths are relative to `https://api.qivo.io`):

| Operation | MCP tool | REST request |
| --- | --- | --- |
| List tasks | `list_tasks` | `GET /v1/tasks` |
| Read a task | `get_task` | `GET /v1/tasks/{ref}` |
| Create a task | `create_task` | `POST /v1/tasks` |
| Update, move or label a task | `update_task` | `PATCH /v1/tasks/{ref}` |
| Delete a task | `delete_task` | `DELETE /v1/tasks/{ref}` |
| Link two tasks | `set_task_link` | `POST /v1/tasks/{ref}/links` |
| Remove a link | `set_task_link` with `linked: false` | `DELETE /v1/tasks/{ref}/links/{kind}/{other}` |
| List labels | `list_labels` | `GET /v1/labels` |
| Create or edit a label | `set_label` | `POST /v1/labels`, `PATCH /v1/labels/{id}` |
| List a task's files | `get_task` (`attachments`) | `GET /v1/tasks/{ref}/attachments` |
| Attach a file | `start_attachment_upload`, then the upload and `confirm_attachment_upload` | `POST /v1/tasks/{ref}/attachments`, then the upload and the confirm |
| Attach text you write | `attach_text_file` | (MCP only) |
| Delete a file | `delete_attachment` | `DELETE /v1/tasks/{ref}/attachments/{id}` |
| Read a task's history | `list_task_activity` | `GET /v1/tasks/{ref}/activity` |
| Planned hours per person and week | `get_workload` | `GET /v1/workload` |
| Edit or delete a comment | `update_comment`, `delete_comment` | `PATCH /v1/comments/{id}`, `DELETE /v1/comments/{id}` |
| Follow or stop following a task | `set_following` | `PUT /v1/tasks/{ref}/following`, `DELETE /v1/tasks/{ref}/following` |
| Read your inbox | `list_inbox` | `GET /v1/inbox` |
| Mark, remove or snooze inbox items | `update_inbox` | `POST /v1/inbox/{action}` |

Use the current task names; former endpoint and tool names are not aliases.
Refresh cached MCP discovery or reconnect if the client still has an older
tool catalogue. Use deletion only when the user asks to delete a task;
archiving retains the task and its history. A delete moves the task, with its
comments, files, links and labels, to Deleted items, and its subtasks stay as
top-level tasks. Agents cannot restore it. A person can restore it in the
app within 30 days, after which it is deleted for good. Deleted items names
the credential that deleted the task.

## Resolve the work and people

Call `list_projects` to identify the intended project and its sub-projects.
Tasks live in sub-projects. For `create_task`, pass the sub-project as
`project`, or pass its meta-project as `project` and that meta-project's child
as `sub_project`.

Machine project references accept a UUID, project key, or per-organization
number; MCP reference arguments are strings. Prefer UUIDs or numbers for
stored references because keys can change. Task references accept the returned
`QN-<number>`, bare number, or UUID. Task numbers are permanent and scoped to
one organization; use the credential for the intended organization.

Before writing `assignee_id`, `reviewer_id` or `reporter_id`, call
`list_project_users` with the destination project, or REST
`GET /v1/projects/{ref}/users`. Any returned profile may be the reporter; only
`assignable: true` profiles may be assignees or reviewers. On a subtask, the
assignee or reviewer must also be able to see every task above it, which
`assignable` does not show; Qivo refuses the write otherwise.
The general `list_users` roster does not prove project access. Names, emails,
and external-system IDs are not valid substitutes for Qivo profile UUIDs.

On creation, omitting `reporter_id` credits the credential's user. Supply a
profile UUID from the destination project's users to choose another reporter;
explicit `null` is refused. The reporter cannot be changed or cleared after
creation. The browser uses its signed-in user and offers no reporter picker.
Tasks expose Reporter, Assignee and Reviewer; the activity trail still records
the credential's user as the actor. Comments are authored by that user too.

## Find, read, change, verify

For an existing task, use `list_tasks` with the resolved `project` and useful
filters, then `get_task` with the returned task reference. Read
`list_comments` with the same `ref` when the discussion matters. It answers
up to 50 of the newest comments (`limit` asks for fewer), oldest first, and
fewer when they are long. To read further back, pass the first comment's
`id` as `before`; an empty list means there are no earlier comments. REST
reads and posts comments at `/v1/tasks/{ref}/comments` and takes the same
`limit` and `before` as query parameters; its comment records identify the
task by `task_id`. Search matches every
whitespace-separated fragment across task ID, title, description, status,
priority, assignee name and label names, case-insensitively and in any order,
like the app's task filter. MCP treats `*` literally; REST supports
it as a wildcard. Resolve multiple plausible matches before editing.

Call `update_task` with `ref` and only the requested changes, or
`create_task` for new work. Re-read the task to verify the saved result and
report its actual ID or browser link. If a creation request loses its
response, search for the task before retrying to avoid duplicates.

A change that collided with other changes made at the same moment, such as
several agents commenting on one task at once, answers `the request
conflicted with other changes made at the same time and changed nothing;
send it again`, as REST `503` with `Retry-After: 1` or as the MCP tool's
error. Nothing was saved, so wait a second and send the same request again.
`internal error` (REST `500`) does not say whether the change was saved, so
read the task first, as after a lost response.

Useful field rules:

- Status: `backlog`, `todo`, `progress`, `review`, `done`. Priority: `urgent`,
  `high`, `medium`, `low`. Titles, and project, milestone and team names, must
  be nonblank and at most 80 characters, counted as Unicode code points (most
  single emoji count as one, a flag or a skin-tone emoji as two).
- Descriptions and comments use Markdown, up to 20,000 characters each
  (JavaScript string length, so an emoji can count as two). A task holds at
  most 400 comments; past that, post in a new task. Omitted update
  fields stay unchanged. Use `null` to clear `assignee_id`, `reviewer_id`, `due_date`, or
  `remaining_hours`; use `""` to clear a description.
- While a task is in `review` with a reviewer set, it is the reviewer's to act
  on; otherwise it is the assignee's. A task with subtasks takes no reviewer.
- Moving a task to `review`, or creating it there, sets `remaining_hours` to
  the project's review time (2 hours by default) unless the same call sends a
  non-null `remaining_hours`. Leaving `review` keeps whatever is left. Re-read
  the task to see the value; MCP `updated` lists only the fields you sent.
- Reporter is set only when creating a task. Any update containing
  `reporter_id` is refused in full, including its other requested changes.
- `remaining_hours` means work left, not the original estimate. A task with
  `is_group: true` derives its progress, remaining work and planned weeks from
  active subtasks. A subtask in an archived project makes no task in an
  active project a group. Setting its status, dates, a non-null
  `remaining_hours` or `paused: true` is refused, as is clearing its dates;
  `remaining_hours: null` and `paused: false` pass, so a stored value can be
  cleared. Inspect the subtasks to determine which changes match the user's
  request.
- `start_week` and `end_week` plan a task, as `YYYY-MM-DD` on both
  interfaces. Send both to schedule, or both as `null` to clear. After a
  change, both dates must exist or both be absent, with start no later than
  end. On a task with `is_group: true`, both dates are calculated from the
  subtasks you can read and cannot be changed; schedule its subtasks
  instead. `due_date` is a separate deadline. Both dates name the first day
  of a week, and the end week is included. For a Monday-based calendar,
  `2026-09-21` through `2026-09-28` is two weeks. Read the first day of the
  week from `organization.week_start` in `get_me` or `GET /v1/me`; do not
  assume Monday for every organization.
- An agent's `plannable_hours: null` means no weekly capacity limit in Qivo,
  not zero capacity. Human capacity is shared across projects.
- `owner_id` names whose work a task is. Filter with `owner_id` (MCP) or
  `owner` (REST) to find someone's work including their reviews. `status`
  takes a list on MCP and comma-separated values on REST.
- A group's `progress` is the app's Progress, the done and total tasks
  without subtasks under it that you can read; `partial: true` means some
  are hidden from you, or an archived group holds too many to read, so its
  completion is unknown. `delay` is the app's
  projected delay (`status` `ok`, `behind` or `late`, with
  `projected_end_week`), or `null` when the project does not track delay or
  the app shows no verdict; it is judged on today's date in UTC.
  `last_comment_at` is when the task was last commented on, or `null`. `get_project` and
  `GET /v1/projects/{ref}` add `completion`, the Overview's done and total
  tasks. If a task list asks for a smaller limit, its rows' newest comments
  and parents were too large to read at once; retry with a smaller `limit`. If it says
  the organization's active tasks are too large to list, a smaller `limit`
  does not help.

## Subtasks, moves, links and labels

- **Subtask:** create the task with `parent` set to the parent's task
  reference. You need User or Lead access on the parent's project, because the
  parent becomes a group and loses its own remaining hours. A subtask stays in
  its parent's top-level project, in any of its sub-projects. Change the parent
  later with `parent` on `update_task` or PATCH, or detach it with
  `parent: null`. `get_task` and `GET /v1/tasks/{ref}` list `subtasks`; a
  `parent_id` of `null` with `has_hidden_parent: true` means the parent
  exists but you cannot read it.
- **Move:** send `project`, and `sub_project` when `project` names a
  meta-project, on `update_task` or PATCH. You need User or Lead access on
  both sub-projects, and the task's assignee and reviewer must be able to work
  in the destination. If they cannot, send a new `assignee_id` or
  `reviewer_id`, or `null`, in the same request. The task keeps its key. A
  move to another top-level project carries the task's subtasks along, so a
  task with more than 200 subtasks cannot make it. A subtask moved there must
  leave its parent in the same request, with `parent: null` or a new parent
  in that project.
- **Link:** `set_task_link` with `ref`, `other`, `kind` (`blocks`,
  `blocked_by` or `relates`, as seen from `ref`) and `linked`, or the REST
  links routes. Two tasks share at most one link; remove a link before
  adding another kind. `get_task` lists `links`.
- **Label:** find label ids or names with `list_labels` or `GET /v1/labels`,
  then send `add_labels` and `remove_labels` on `update_task` or PATCH.
  `set_label` or `POST /v1/labels` creates a label (`#rrggbb` color); only
  organization admins rename or recolor one.
- **Archive with a reason:** send `archived: true` with `archive_reason`; the
  reason becomes a comment, as in the app's archive dialog. Only tasks take
  a reason. Archive a project with `archived` alone.

## Files, history and workload

- **Read files:** `get_task` and `GET /v1/tasks/{ref}` list `attachments`,
  each with a download `url` that works for 10 minutes
  (`url_expires_at`). Read the task again for a fresh link. `inline: true`
  marks an image inside the description.
- **Attach a file:** `start_attachment_upload` or
  `POST /v1/tasks/{ref}/attachments` with `name`, optional `content_type`
  and the exact byte `size`; then POST the bytes to the returned
  `upload_url` with the file's `Content-Type` and no Authorization header;
  then `confirm_attachment_upload` or
  `POST /v1/tasks/{ref}/attachments/{ticket}` with the `storage_id` the
  upload answered. Only the same user can confirm, within an hour, on
  either interface. The file never passes through the MCP call. An OAuth
  connection uses the MCP tools, since its token does not reach these REST
  routes. The organization's per-file limit is `max_attachment_mb` in
  `get_me`.
- **Attach text you write:** `attach_text_file` with `name`, `text` and an
  optional `content_type` stores notes, a CSV table or a log as a UTF-8
  file of at most 256 KiB in one call. Chat assistants that cannot make
  HTTP requests can still attach text they write this way. Send MCP
  requests as UTF-8, because Qivo refuses a body with other bytes.
- **Delete a file:** `delete_attachment` or
  `DELETE /v1/tasks/{ref}/attachments/{id}`, with User or Lead access to the
  project. Description images are left to the app. When you rewrite a
  description, keep its `![alt](att:<id>)` references. The next time someone
  saves that description in the app, the app deletes every image uploaded
  more than a day ago that the description no longer names.
- **History:** `list_task_activity` or `GET /v1/tasks/{ref}/activity`
  answers who changed what, oldest first. Comments are in `list_comments`.
- **Workload:** `get_workload` or `GET /v1/workload` answers each person's
  planned hours per week (`hours`, aligned with `week_starts`) beside their
  `plannable_hours`. Use it before assigning or scheduling work. For
  organization admins and Standard users, `hours` already includes work in
  projects hidden from you, and `hidden_hours` is that part of `hours`,
  without names. Do not add the two. Viewers and guests get only work they
  can see or own.

## Comments, inbox and following

- **Edit or delete a comment:** `update_comment` or `delete_comment` with the
  comment's `id` from `list_comments`, or REST `PATCH` and `DELETE
  /v1/comments/{id}`. Only the comment's author or a lead of the task's
  project may. An edit that adds a mention notifies that person.
- **Follow a task:** `set_following` with `ref` and `following`, or REST `PUT`
  (follow) and `DELETE` (stop) on `/v1/tasks/{ref}/following`. Followers get
  the task's updates in their inbox. `get_task` shows `following` and
  `followers`. You are also made a follower when you are assigned, mentioned
  or comment.
- **Read your inbox:** `list_inbox` or `GET /v1/inbox` answers `items`, one
  per active task you can read, latest activity first, with its unread count
  and messages. Use `unread_only` to see what is new. The task title shown is
  the current one. One call lists up to 500 unread messages (newest first)
  and up to 500 read ones (most recently read first), and looks at no more
  than 1,000 of each, counting messages about tasks it does not list.
  `truncated: true` means some were not looked at, so mark everything read
  to shrink the inbox. The app's Inbox loads up to 500 of them, unread
  first. An item keeps at most 50 unread messages, dropping the oldest
  except its first unread one and the newest of each kind. Archiving a task
  or project marks the messages about its tasks read for everyone, and
  messages about an archived task arrive read.
- **Clear your inbox:** `update_inbox` with `action` (`read`, `unread`,
  `remove` or `snooze`) and `tasks` (at most 100 per call), or REST
  `POST /v1/inbox/{action}` with `{"tasks": [...]}`. `all: true` with `read`
  marks everything read, and with `remove` removes every read item; repeat
  while `has_more` is `true`. With `read`, send back the `before` each
  answer returns, so messages that arrive meanwhile stay unread.
  `snooze` needs `until` (an ISO date-time within a year, or `null` to bring
  items back). `unread` and `snooze` refuse an archived task, or a task in an
  archived project, until whatever is archived (the task, its project or both)
  is restored, while `read` and `remove` still work on it. Mark items read
  once you have handled them, so new updates stand out. Retention never
  removes unread messages, and an agent's read messages are removed after 7
  days. A Viewer agent receives no new messages and cannot clear its inbox,
  but can still read the messages it holds.

## Projects, access and milestones

| Operation | MCP tool | REST request |
| --- | --- | --- |
| Read a project | `get_project` | `GET /v1/projects/{ref}` |
| Create a project or sub-project | `create_project` | `POST /v1/projects` |
| Change, archive or restore a project, hand over its lead | `update_project` | `PATCH /v1/projects/{ref}` |
| Give, change or remove one user's or team's access | `set_project_access` | `PUT` and `DELETE /v1/projects/{ref}/access/users/{user}` or `…/teams/{team}` |
| Add, rename or move a milestone | `set_milestone` | `POST /v1/projects/{ref}/milestones`, `PATCH …/milestones/{id}` |
| Delete a milestone | `delete_milestone` | `DELETE /v1/projects/{ref}/milestones/{id}` |

- **Create:** a top-level project follows the organization's project
  creation setting; check `can_create_projects` in `get_me` or `GET /v1/me`
  first. A Standard user agent counts as a standard user there. Create a
  sub-project with `parent`, which needs Lead access on that parent. Tasks go
  in sub-projects. The lead defaults to you, and an agent always leads what
  it creates and cannot hand it over, so create a project only when the user
  asks for one.
- **Change:** settings, archive and restore need Lead access. Archiving a
  project hides its tasks from default task lists; restore it before adding
  tasks.
- **Access and lead:** only a person who is an organization admin or the
  project's lead may change who has access or hand over the lead. An agent's
  credential is refused. Before removing someone, choose `on_held_tasks`:
  `leave` (default) lists the open tasks they lose sight of, `keep_as_viewer`
  keeps them as Viewers, and `{"reassign_to": user id or null}` hands those
  tasks over, at most 120 in one removal and fewer when they have many
  followers. Confirm the choice with the user when it is not clear. A
  misspelled `on_held_tasks` is refused, on MCP and on these REST routes.
- **Milestones:** they live on the top-level project; naming a sub-project
  adds them there. `date` is `YYYY-MM-DD`. `get_project` lists them.

## Teams

| Operation | MCP tool | REST request |
| --- | --- | --- |
| List teams with their members and leaders | `list_teams` | `GET /v1/teams`, `GET /v1/teams/{id}` |
| Create or rename a team | `set_team` | `POST /v1/teams`, `PATCH /v1/teams/{id}` |
| Add a member, make or unmake a leader | `set_team_member` with `member: true` | `PUT /v1/teams/{id}/members/{user}` |
| Remove a member | `set_team_member` with `member: false` | `DELETE /v1/teams/{id}/members/{user}` |

- **Who may:** only organization admins create teams. An organization admin
  or a leader of the team renames it and changes its members, and only a
  person may change members, so an agent's credential is refused. Only
  people lead teams.
- **Removing:** choose `on_held_tasks` as for project access. `leave`
  (default) lists the open tasks the member loses sight of,
  `keep_as_viewer` keeps them as a Viewer of the project the team shared,
  and `{"reassign_to": user id or null}` hands those tasks over, at most 120
  in one removal and fewer when they have many followers. Confirm the choice
  with the user when it is not clear. A misspelled `on_held_tasks` is
  refused, on MCP and on these REST routes.
- Teams are named by uuid; two teams may share a name.

## Receive task events

Use push delivery when the user requests ongoing task-change notifications.
The receiving integration needs a public HTTPS callback on port 443. A webhook
settings page is unnecessary; connecting an ordinary MCP tool client does not
provide a receiver or automatically start agent work. Configure the intended
receiver before subscribing. Qivo sends no application-specific bridge messages.

Choose one of `task.created`, `task.updated`, `task.deleted`, `task.restored` or
`comment.created`. `task.deleted` means the task moved to Deleted items, and
`task.restored` that a person restored it there.
Subscribe separately for each event type. Optional `arguments.task_id` and
`arguments.project_id` take UUIDs from task/project discovery, not QN refs or
project keys. A project filter names exactly one task-containing sub-project.
Parent meta-projects are refused; filters do not include children.
Omit filters to monitor matching events across readable projects.

With an agent key, send `POST https://api.qivo.io/v1/webhooks` using
`Authorization: Bearer <full-qva-secret>` and this JSON body:

```json
{
  "name": "task.updated",
  "arguments": { "project_id": "<project UUID>" },
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example/qivo-events",
    "secret": "whsec_<base64-encoded random signing key>"
  }
}
```

The receiver must verify Standard Webhooks signatures and answer the registration
challenge with a `2xx` JSON response containing the same `challenge` value.
Only then does Qivo activate the subscription. The webhook signing key is
separate from the Qivo access credential. See
[callback setup](https://qivo.io/auth.md#configure-a-task-event-receiver).

For an MCP Events client, `server/discover` advertises `events: {}` and
`events/list` discovers event definitions. Send `events/subscribe` with the
same parameters. These are draft protocol methods, not tools in `tools/list`.
Qivo supports them on its modern protocol leg. For a direct JSON-RPC POST to
`https://api.qivo.io/mcp`, include this in `params` alongside the subscription
parameters:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  }
}
```

The outer request uses `jsonrpc: "2.0"`, an `id` and `method: "events/subscribe"`.
Send the normal MCP credential, `Content-Type: application/json` and
`Mcp-Method: events/subscribe`. Every modern request needs `Mcp-Method` matching
its JSON-RPC method, including `events/list` and `events/unsubscribe`.
Use the client's supported MCP Events interface when available. A tool-only
client can use REST webhook management with its credential instead.

On REST, omit `ttlMs` or send null for no expiry. On MCP, omission requests seven
days; send `ttlMs: null` for no expiry. A positive integer TTL is clamped between
60 seconds and seven days.
Renew finite subscriptions before `refreshBefore`; `refreshBefore: null` means
renewal is unnecessary. Existing subscriptions keep their stored expiry until
registered again. Each renewal applies the same rules, so omitting `ttlMs` in an
MCP renewal sets a seven-day expiry. Event subscriptions do not create persistent
MCP sessions.

Payloads identify the task and changed fields; read current content with
`get_task` or REST GET. Verify signatures before acting and deduplicate by
`eventId`. Deliveries may arrive more than once or out of order. Acknowledge with
`2xx` only after accepting the event for processing. This acknowledgment does
not tell Qivo whether the agent completed its work. Deleted tasks cannot be
read until a person restores them.
`changed_fields` uses stored task-column names, including server-maintained fields.
Do not treat it as an API write payload. For example, `archived_at` reports an
archive change, while the API write uses `archived`.

Matching events include the integration's own writes. Prevent feedback loops
before changing a task in response to its event. Make changes idempotent, track
work already processed, and use `actor_id` when ignoring your own actor is
appropriate. Event-ID deduplication alone does not stop a loop that creates new
events with each write.

Use the owning agent key, personal token or a current OAuth access token for the
same connection to list subscriptions with `GET /v1/webhooks`. The result
includes callback URLs, expiry, active/disabled status, failure reason and delivery
timestamps/status. No signing key is returned. A `2xx` clears the failure streak;
a further failure after seven days without an acknowledgment disables delivery.
One failed event followed by silence does not disable a quiet subscription.
Qivo sends no health probes. A finite subscription can expire before the health
window elapses, so renew before expiry. An event has at most eight total
attempts, including the first. The seven retry delays are 10, 20, 40, 80, 160, 320 and 640 seconds.
They total 21 minutes 10 seconds; request duration and queue delays add to that
time. This retry budget is separate from the seven-day subscription health rule.
`408`, `425` and `429` responses retry. `410 Gone` stops only that event without
changing the subscription or its failure streak.

Fix a disabled receiver, then repeat registration with the same credential,
event name, filters and URL. Verification re-enables the existing subscription.
Renewing an active subscription preserves its failure streak and health history.
Recovering a disabled subscription clears the streak while retaining prior
success, failure and HTTP-status history. Pending retries survive a verified
refresh before expiry. Registering after expiry or deletion starts fresh and
cannot revive old queued events. There is no replay of failed events or changes
missed while disabled. Registration reclaims quota held
by expired registrations, by revoked, expired or deleted credentials and by
removed accounts. A personal token's subscriptions stop delivering when it
expires.
OAuth subscriptions belong to the connection grant. Access-token expiry,
rotation or revocation of an individual access token does not cancel them.
Disconnect the connected app or unsubscribe to stop them. Unsubscribe through REST
`DELETE /v1/webhooks/{id}` or MCP `events/unsubscribe` with the original event
name, filters and `delivery: { "url": "<original callback URL>" }`. The optional
mode is `"webhook"`; no signing key is needed to unsubscribe.

A person who administers the organization can inspect subscriptions across
owners with `GET /v1/webhooks/organization` and remove one with
`DELETE /v1/webhooks/organization/{id}`. Use that person's token or OAuth
connection. Removing another owner's subscription needs a credential that can
make changes: a personal token with change access, or an OAuth connection with
`qivo:write`. Use these routes to reclaim shared quota when the original owner
cannot remove a callback.

## Stays in the app

These actions have no REST route or MCP tool. Do them in the browser at
`https://qivo.io/app` with the user's signed-in session, or ask the user to
do them there.

- Deleting a project, a team or a label.
- Restoring what is in Deleted items, or deleting it for good.
- Inviting a guest to a project by email.
- Adding or removing other people as followers of a task. A credential
  changes only its own follow.
- Creating or deleting an organization, changing its settings, such as the
  name, address, calendar, attachment limit, default planning hours and who
  can create projects, and exporting its data.
- Billing, subscriptions and payment details.
- Inviting people, adding agents, changing a user's name, email, role or
  **Can create projects**, making a user Inactive and removing a user.
  Plannable weekly hours are the exception (`PATCH /v1/users/{id}`,
  `update_user`).
- Creating, revoking or deleting agent keys, and revoking credentials on
  **API access**.
- A person's own name, picture, appearance, inbox retention and other
  preferences, and their personal access tokens and connected apps.
- Images inside task descriptions. Attach other files through REST or MCP.
- The **Last sync** time on the Team sync page. Changes over REST and MCP do
  not update it.

## Archives, access, and browser links

Archived tasks keep their status. Default task lists omit them;
`archived: true` with `project` lists that project's archived tasks, its
sub-projects' included, most recently archived first, a page at a time.
Archiving a task carries its subtasks; restoring it also restores its parent
chain. `get_task` resolves archived tasks without restoring them.

To find archived tasks anywhere, call `list_projects` once without arguments
and once with `archived: true` (REST `GET /v1/projects` and
`GET /v1/projects?archived=true`), because archived tasks can sit in active
and archived projects. Then list the archived tasks of each top-level
project, the rows whose `parent_id` is `null`. Each covers the sub-projects
you can read.

Archived projects are separate: use `list_projects` with `archived: true` to
find them, then explicitly name one in the task query. They refuse new tasks;
restore a project with `update_project` (`archived: false`) or PATCH when that
is part of the requested work.
A viewer can read but cannot write. A not-found response can also mean the
credential cannot see the object. A read-only credential also prevents writes,
and Qivo refuses its changes before looking up what you named. A read-only
OAuth approval gets HTTP 403 `insufficient_scope`. A personal token without
change access gets `this credential can only read` on MCP and REST, and the
key of an agent whose organization role is Viewer gets `this agent is a
Viewer and can only read`. Reading and managing its own event subscriptions
still work. If the
user's task needs additional access, use the client's OAuth
approval flow to request it; approval still cannot exceed the person's
current project permissions.

Task links use `https://qivo.io/app/<org-slug>/tasks/qn-<number>`; a project board
uses `/app/<org-slug>/board/p/<project-number>`. Use the actual organization
slug and returned IDs. `/app/~/inbox` spans the signed-in user's
organizations, and `/app/~/archive` opens Settings → Projects → Archived tasks.
Archived task links open normally after restoration.

For a complete organization export, an organization admin uses **Settings →
Organization → General → Export data** in the browser. Export format 2 uses
`data/tasks.json`, `data/task_links.json`, `data/task_labels.json` and
`data/task_attachments.json`; related records use `task_id`. Read the export
manifest for its version, counts and file mapping.

For browser details, consult
[navigation](https://qivo.io/docs/finding-your-way-around/),
[the task window](https://qivo.io/docs/the-task-window/), and
[access rules](https://qivo.io/docs/who-sees-what-the-access-model/).
