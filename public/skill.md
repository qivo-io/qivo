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
automation acting as a named agent user and for REST access. Use an existing
working connection for the requested task.

## Choose the interface

- **Connected MCP:** Prefer it for routine task discovery, edits, comments,
  and archive/restore. The endpoint is `https://api.qivo.io/mcp`. Use the
  client's discovered tools and current `tools/list` schemas for arguments.
  `list_tasks` defaults to 50 results, allows at most 200, and has no offset.
  Narrow the query; a full result limit does not prove you found every task.
- **REST:** Use `https://api.qivo.io/v1` with an agent key for paginated reads
  or scheduled weeks. OAuth and personal MCP tokens work only on the REST webhook
  management routes, not these task and project routes.
  `GET /v1/tasks?project=<ref>&limit=200&offset=0` returns an
  array; increment `offset` by the page size until a shorter page arrives.
  `PATCH /v1/tasks/{ref}` accepts `start_week` and `end_week` as
  `YYYY-MM-DD`: send both to schedule, or both as `null` to clear. After a
  patch, both dates must exist or both be absent, with start no later than end.
  These fields are not MCP write arguments; `due_date` is a separate deadline.
  Both dates name the first day of a week, and the end week is included. For
  a Monday-based calendar, `2026-09-21` through `2026-09-28` is two weeks.
  Confirm the organization's **Workdays start on** setting in **Settings →
  Organization → General**, or ask the user if that setting is unavailable;
  do not assume Monday for every organization.
- **Browser:** Use it for task moves, project creation/sharing, project
  archive/restore, attachment uploads, and other actions absent from the machine
  interfaces. Enter at `https://qivo.io/app` and use the user's signed-in
  session. Follow an explicitly requested interface when it supports the work.

Task operations use these names (REST paths are relative to `https://api.qivo.io`):

| Operation | MCP tool | REST request |
| --- | --- | --- |
| List tasks | `list_tasks` | `GET /v1/tasks` |
| Read a task | `get_task` | `GET /v1/tasks/{ref}` |
| Create a task | `create_task` | `POST /v1/tasks` |
| Update a task | `update_task` | `PATCH /v1/tasks/{ref}` |
| Delete a task | `delete_task` | `DELETE /v1/tasks/{ref}` |

Use the current task names; former endpoint and tool names are not aliases.
Refresh cached MCP discovery or reconnect if the client still has an older
tool catalogue. Use deletion only for requested permanent removal; archiving
retains the task and its history.

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
`assignable: true` profiles may be assignees or reviewers.
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
`list_comments` with the `task` argument when the discussion matters. REST
reads and posts comments at `/v1/tasks/{ref}/comments`; its comment records
identify the task by `task_id`. Search matches every
whitespace-separated fragment across task ID, title, and description,
case-insensitively and in any order. MCP treats `*` literally; REST supports
it as a wildcard. Resolve multiple plausible matches before editing.

Call `update_task` with `ref` and only the requested changes, or
`create_task` for new work. Re-read the task to verify the saved result and
report its actual ID or browser link. If a creation request loses its
response, search for the task before retrying to avoid duplicates.

Useful field rules:

- Status: `backlog`, `todo`, `progress`, `review`, `done`. Priority: `urgent`,
  `high`, `medium`, `low`. Titles must be nonblank and at most 80 characters.
- Descriptions and comments use Markdown. Omitted update fields stay
  unchanged. Use `null` to clear `assignee_id`, `reviewer_id`, `due_date`, or
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
  `is_group: true` derives its progress and remaining work from active subtasks;
  direct status/hour edits are refused. Inspect the subtasks to determine
  which changes match the user's request.
- An agent's `plannable_hours: null` means no weekly capacity limit in Qivo,
  not zero capacity. Human capacity is shared across projects.

## Receive task events

Use push delivery when the user requests ongoing task-change notifications.
The receiving integration needs a public HTTPS callback on port 443. A webhook
settings page is unnecessary; connecting an ordinary MCP tool client does not
provide a receiver or automatically start agent work. Configure the intended
receiver before subscribing. Qivo sends no application-specific bridge messages.

Choose one of `task.created`, `task.updated`, `task.deleted` or `comment.created`.
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
not tell Qivo whether the agent completed its work. Deleted tasks cannot be read.
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
by expired registrations, revoked/deleted credentials and removed accounts.
OAuth subscriptions belong to the connection grant. Access-token expiry,
rotation or revocation of an individual access token does not cancel them.
Disconnect the connected app or unsubscribe to stop them. Unsubscribe through REST
`DELETE /v1/webhooks/{id}` or MCP `events/unsubscribe` with the original event
name, filters and `delivery: { "url": "<original callback URL>" }`. The optional
mode is `"webhook"`; no signing key is needed to unsubscribe.

A person who administers the organization can inspect subscriptions across
owners with `GET /v1/webhooks/organization` and remove one with
`DELETE /v1/webhooks/organization/{id}`. Use that person's token or OAuth
connection. OAuth administrator deletion requires `qivo:write`. Use these
routes to reclaim shared quota when the original owner cannot remove a callback.

## Archives, access, and browser links

Archived tasks keep their status. Default task lists omit them;
`archived: true` lists archived tasks instead. Archiving a task carries its
subtasks; restoring it also restores its parent chain. `get_task` resolves
archived tasks without restoring them.

Archived projects are separate: use `list_projects` with `archived: true` to
find them, then explicitly name one in the task query. They refuse new tasks;
restore a project in the browser when that is part of the requested work.
A viewer can read but cannot write. A not-found response can also mean the
credential cannot see the object. A read-only OAuth approval also prevents
writes. If the user's task needs additional access, use the client's OAuth
approval flow to request it; approval still cannot exceed the person's
current project permissions.

Task links use `https://qivo.io/app/<org-slug>/tasks/qn-<number>`; a project board
uses `/app/<org-slug>/board/p/<project-number>`. Use the actual organization
slug and returned IDs. `/app/~/inbox` and `/app/~/archive` span the signed-in
user's organizations. Archived task links open normally after restoration.

For a complete organization export, an organization admin uses **Settings →
Organization → General → Export data** in the browser. Export format 2 uses
`data/tasks.json`, `data/task_links.json`, `data/task_labels.json` and
`data/task_attachments.json`; related records use `task_id`. Read the export
manifest for its version, counts and file mapping.

For browser details, consult
[navigation](https://qivo.io/docs/finding-your-way-around/),
[the task window](https://qivo.io/docs/the-task-window/), and
[access rules](https://qivo.io/docs/who-sees-what-the-access-model/).
