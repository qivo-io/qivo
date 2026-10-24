# Qivo MCP server

The temporary `demo.qivo.io` service is browser-only: it does not issue or
accept external agent credentials or OAuth connections. Its MCP endpoint
answers every MCP `POST` with HTTP `403`, and it serves no OAuth metadata. Use
a regular Qivo workspace for this interface.

Qivo exposes the planner to Claude (and any MCP client) through a
[Model Context Protocol](https://modelcontextprotocol.io) server — a Convex
HTTP action, speaking MCP Streamable HTTP at protocol revision
**2026-07-28** (and still answering 2025-era clients — see
[Protocol revision](#protocol-revision)):

```
https://api.qivo.io/mcp
```

Against a dev deployment: `https://<deployment>.convex.site/mcp`

## Deployments and client refresh

MCP agents do not load the website's JavaScript bundle. Each `tools/call`
POST is handled by the deployed Convex server, so new backend behavior is
available to subsequent calls without reloading the website or reconnecting
an existing server session. There is no server session on this endpoint.

Tool discovery is separate: a client can retain the tool names, descriptions
and argument schemas it previously fetched. The modern `tools/list` and
`server/discover` responses advertise a private one-hour cache lifetime, and
this server does not send tool-catalog change notifications. Task events use
the separate webhook interface below. After a tool-surface change,
refresh the client's tool discovery (or reconnect it if that is how the
client refreshes tools); older clients control their own discovery cache.
`serverInfo.version` is a fixed API identity, not the website's build version
or a deployment-change signal. Backend releases must still preserve
compatibility with older tool schemas that clients may hold.

The task Reviewer added a `reviewer_id` argument to `create_task` and
`update_task` and changed several tool descriptions. A client holding the
older catalogue keeps working, but its model does not learn about
`reviewer_id` or the review time until the client refreshes its tool list.
Task parity added plan weeks, `parent`, moves, labels and `archive_reason`
to those two tools, `owner_id`, `offset` and status lists to `list_tasks`,
and the `set_task_link`, `list_labels` and `set_label` tools.

Parity with the app also added `get_me`; `update_comment` and
`delete_comment` for comments; `list_inbox`, `update_inbox` and
`set_following` for the inbox and follows; and `delete_attachment`,
`list_task_activity` and `get_workload` for files, task history and workload.
`create_task` now also takes `paused`. A client holding an older catalogue
does not see these until it refreshes its tool list.

Project parity added `get_project`, `create_project`, `update_project`,
`set_project_access`, `set_milestone` and `delete_milestone`. A client
holding an older catalogue does not see them until it refreshes its tool
list.

Team parity added `set_team` and `set_team_member`, and `list_teams` now
answers each team's `members`. A client holding an older catalogue still
reads the new field, but does not see the two tools until it refreshes its
tool list.

The text limits added `maxLength` 20,000 to `description` on `create_task`
and `update_task`, to `archive_reason` on `update_task` and to `body` on
`add_comment` and `update_comment`. A client holding the older catalogue
keeps working.

Comment paging added `limit` and `before` to `list_comments`, which now
answers a task's newest 50 comments unless asked for fewer, and
`add_comment`'s description now says that a task holds at most 400
comments. A client holding an older catalogue keeps working and reads the
newest comments, but its model does not learn how to read further back, or
about the limit, until the client refreshes its tool list.

The name limits added `maxLength` 80 to `name` on `create_project`,
`update_project`, `set_milestone` and `set_team`. A client holding the older
catalogue keeps working.

In October 2026 `list_tasks` changed in two ways. It returns active tasks in
creation order, oldest first, like REST, instead of by project key and task
number, so restart any paging with `offset` after this change. With
`archived: true` it now needs `project` and answers
`{next_cursor, tasks}`, paged with the new `cursor` argument (see
[Task results](#task-results)). A client holding the older catalogue does
not see `cursor` until it refreshes its tool list.

Later in October 2026 a task stopped limiting its comments and stopped
deleting its oldest history. `add_comment`'s description no longer names a
comment limit, `list_task_activity` added `before` to read a task's history
further back, and `archive_reason` on `update_task` declares `maxLength` 500,
the server's new limit. A client holding the older catalogue keeps working
and reads the newest history, but its model does not learn how to read
further back until the client refreshes its tool list.

The subtask limits added a sentence to the `create_task`, `update_task`
and `set_following` descriptions: a task has one level of subtasks, at most
100 of them, and at most 100 followers. A client holding the older catalogue
keeps working, and the server refuses such a call with the rule's sentence.

The subtask project rule added a sentence to the `create_task` and
`update_task` descriptions, which now say that a parent must be in the
task's top-level project, that a move to another top-level project carries
the subtasks along, and that a subtask moved there must leave its parent in
the same call. A client holding the older catalogue keeps working, and the
server refuses such a call with the rule's sentence, but its model does not
learn the rule until the client refreshes its tool list.

File uploads added `start_attachment_upload`, `confirm_attachment_upload`
and `attach_text_file` (see [Attachments](#attachments)). A client holding
an older catalogue does not see them until it refreshes its tool list. At
the same time every tool began to refuse a string argument, or a string
inside an object argument such as `on_held_tasks`, holding an unpaired
surrogate, such as a lone `\ud83c` escape, with the schema message
`Invalid string: has an unpaired surrogate, which UTF-8 cannot encode`.
Such a call answered `internal error` before. A request body that is not
UTF-8 is now refused with a parse error (see
[Request limits and billing](#request-limits-and-billing)). Before, Qivo
replaced each invalid byte sequence with U+FFFD and ran the call.

Every tool that takes arguments now refuses one its schema does not know,
before anything runs, with `Input validation error: Invalid arguments for
tool <name>: Unrecognized key: "<argument>"`. Before, such an argument was
dropped, and only `create_task`, `update_task` and `update_project` named it
in `ignored_arguments`, which no tool returns now. Their descriptions no
longer mention it, and a client holding the older catalogue reads the old
sentence until it refreshes its tool list. A misspelled `on_held_tasks`
therefore no longer removes access with the default. `arguments` that is not
an object, such as a string, is refused too, rather than read as no
arguments. A tool that takes no arguments (`get_me`, `list_teams`,
`list_users` and `list_labels`) still ignores what it is sent, because some
clients send a placeholder argument to such tools.

The per-task limits changed the `create_task` and `update_task`
descriptions. `create_task` now says a task has at most 100 active
subtasks, archived ones aside, and `update_task` that a subtask restored
under a parent with 100 active subtasks comes back without it. The tools
take the same arguments, so a client holding the older catalogue keeps
working, and the server answers such a call as described here.

Description saves that settle their images changed the `delete_attachment`
description from "Description images (`inline: true`) are left to the app."
to "A description image (`inline: true`) goes when the description stops
showing it." The tool takes the same arguments.

Deleted items changed the `delete_task` description to "Move a task to
Deleted items, where a person can restore it in the app." The tool takes the
same arguments and answers the same way, so a client holding the older
catalogue keeps working. Its model reads the old description, which does not
say that a person can restore the task, until the client refreshes its tool
list.

In October 2026 every `list_tasks` and `get_task` result gained `progress`
and `last_comment_at`, and `get_project`, `create_project` and
`update_project` gained `completion` (see [Task results](#task-results) and
[Projects, access and milestones](#projects-access-and-milestones)). The
three read tools' descriptions now name the new fields. A client holding the
older catalogue reads them too, but its model does not learn what they mean
until the client refreshes its tool list. An active `list_tasks` page whose
tasks' newest comments do not fit in one request is refused with `this page
of tasks is too large to read at once; ask for a smaller limit`, or with
`this organization's active tasks are too large to list in one request`
when none fit (see [Task results](#task-results)).

Later in October 2026 every `list_tasks` and `get_task` result gained
`delay`, the app's projected delay (see [Task results](#task-results)). The
`list_tasks` and `get_task` descriptions now name it. A client holding the
older catalogue reads it too, but its model does not learn what it means
until the client refreshes its tool list.

The label limit added `maxLength` 40 to `name` on `set_label`. A client
holding the older catalogue keeps working.

In October 2026 the server's sentences lost their em dashes. A refusal
that read `that project is archived — restore it first` now reads `that
project is archived, so restore it first`, and the activity rows that MCP
and REST writes sign join their detail and provenance with a comma, such as
`(status To Do → In Progress), via MCP`. A link row reads `(blocks QN-12)`
and a label row names the label in quotes, such as `“Bug”`. Rows stored
before keep their old text. Match a refusal by its error code or HTTP status,
not its wording. The descriptions of `list_projects`, `list_users` and
`update_user` changed the same way, and a client holding the older catalogue
reads the old text until it refreshes its tool list.

Single-use upload URLs changed the `start_attachment_upload` description,
which now says to send exactly `size` bytes in one POST. The tool takes the
same arguments and answers the same way. Its `upload_url` now points at
Qivo and stores one file, where before it was a Convex URL that stored a
file for every POST until it expired (see [Attachments](#attachments)).

In October 2026 `update_task`, `update_comment`, `delete_comment`,
`update_project`, `set_project_access`, `set_milestone`, `delete_milestone`,
`set_label`, `set_team` and `update_user` gained an optional `expected`
argument, the values you last read of the fields the call changes, and their
descriptions end with a sentence about it. A call whose fields someone else
changed since is refused and saves nothing (see [Refusing a change when a
field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). A client
holding the older catalogue keeps working, but its calls save without the
check until the client refreshes its tool list and its model learns to send
`expected`.

Later in October 2026 the schema of `expected` gained the rules of the
typed keys' fields: a date pattern on the date keys, the ranges of the hour
keys and the color pattern. A
value that breaks the rule, such as `expected.due_date: "2026-02-31"`, is
now refused with its own sentence before Qivo compares anything, where
before it could be answered as a changed field. `expected` on
`create_task`, `add_comment` and `create_project` now answers `expected
applies only when changing an existing task` (or `comment`, `project`)
instead of `Unrecognized key: "expected"`.

Later in October 2026 the text keys of `expected` gained their fields'
rules too. A task's `title`, a name and a comment's `body` must not be
blank, a `title` has at most 80 characters and a label's `name` at most 40.
A value that breaks the rule, such as
`expected.title: ""`, is refused with its own sentence before Qivo compares
anything, where before it was answered as a changed field. The schema of
`expected` carries `minLength` and these `maxLength` values. At the same
time `remaining_hours` got one limit on every interface, 0 to 99999.9 hours.
The schemas of `create_task` and `update_task` already said so, but REST and
the app took any finite nonnegative number, so a task given more over REST
could not be sent back through `update_task`. The server now checks the
range on all three, and `create_task` and `update_task` refuse a number
outside it, `1e309` and negative numbers included, with REST's
`remaining_hours must be a number of hours from 0 to 99999.9, or null`
instead of a schema message such as `Input validation error: …
remaining_hours: Too big: expected number to be <=99999.9`. A value that is
neither a number nor `null` still gets the schema message.

Hours later, a milestone's `expected.date` on `set_milestone` and
`delete_milestone` became checked for the `YYYY-MM-DD` shape only, because a
milestone saved until 2026-10-16 can hold a day that does not exist, such as
`2026-02-31`. Such a day is compared, and text of another shape is refused
with `expected.date must be a date as YYYY-MM-DD` instead of `expected.date
must be a calendar date as YYYY-MM-DD`, which these tools answered from
2026-10-20.

Late in October 2026 every limit got one definition, which the
[Limits](#limits) table lists, and one rule for text: a text counts UTF-16
code units once trimmed, and the trimmed text is stored. A title or name
padded with spaces within its limit is now taken on every interface, and an
emoji counts as two characters in a title or name too, where it counted as
one. A task's `title` holds at most 255 characters, where it held 80, and
the `title` schemas of `create_task` and `update_task` say so. The schema
check stopped applying `maxLength`, `minLength`, `minimum`, `maximum`,
`minItems` and `maxItems`. The schemas still carry them as hints, and the
server checks each one with the limit's own sentence, the one REST answers, such as
`a task title must be at most 255 characters. Shorten it.` or `limit must be
a whole number of tasks from 1 to 200.`, instead of a schema message such as
`Input validation error: … title: Too big: expected string to have <=80
characters`. A JSON Schema validator counts a string's `maxLength` in code
points, so a client that checks arguments itself can accept a title of
emoji that the server, counting UTF-16 code units, refuses; the server's
answer decides. `list_tasks` gained `maxLength` 200 on `search`, and its
description and `list_inbox`'s now give the page size, 50 by default and at
most 200. `update_inbox` says a snooze reaches at most 366 days ahead. An
events/subscribe `ttlMs` outside one minute to seven days is refused
instead of moved into the range, a full subscription quota names both
quotas, and a rate-limited request's `Retry-After` is the seconds left in the
current minute instead of 60. The keys of `expected` follow their fields'
limits too: a `title` has at most 255 characters, a team's, project's or
milestone's `name` is not blank and has at most 80, a comment's `body` and a
task's or project's `description` have their fields' limits, and
`remaining_hours` is at most 99999.9. An id key such as `assignee_id`,
`parent_id`, `project_id` or `lead_id` takes a uuid, and its schema carries
`format: "uuid"`. A client holding the older catalogue keeps working, but
its model reads the old title limit until the client refreshes its tool
list.

## Access model: the credential is a user

MCP authenticates as **one user**, with three connection options. **OAuth is
preferred when a person connects their assistant.** Personal tokens remain
a fallback for clients without compatible OAuth support or for explicitly
requested manual setup; agent keys give automation its own identity.

- **OAuth approval.** A supported client opens Qivo's browser sign-in and
  consent screen, which shows the name the client registered, folded to one
  line and cut to 80 characters followed by `…` when it is longer. Approval
  binds the client to the displayed home profile and organization. The default
  request includes `qivo:read`, `qivo:write` and `offline_access`; the person
  can turn off **Allow changes** to approve reading only. Opaque access tokens
  (`qvo_…`) and rotating refresh tokens (`qvr_…`, when `offline_access` is
  approved) go directly to the client. Delete the connection under **Settings
  → Your preferences → MCP access → Connected apps** to stop its access and
  remove it from the list. Previously revoked connections can also be deleted.
- **A person's token.** Each person mints their own under **Settings → Your
  preferences → MCP access → Personal access tokens**; the secret (`qvt_…`, shown once,
  stored as SHA-256 + display prefix, migration 0030) maps to that account,
  and the client then acts as them. Personal tokens remain a secondary option
  below the OAuth setup and its copyable MCP server address. Each token
  records whether it can make changes or only read, and may record an expiry,
  both fixed when it is created. The settings page's **New token** asks for a
  name, **Allow changes** (on by default) and an optional last day; a token
  with a last day expires when that day ends in the creator's time zone. A
  token stored without an access setting, created before tokens had one, can
  only read. From its expiry a token is refused exactly like a revoked one,
  and it stays listed until its owner deletes it. The same token
  also authenticates the [organization REST API](rest-api.md) as that person.
- **An agent's key.** An agent is a user of the organization that is not a
  person — no email, no password — created by an org admin under **Settings →
  Organization → Users**, where it is given a name and a key (`qva_…`,
  migration 0100). The client acts as the agent, which reaches exactly the
  projects the agent was given a role on. The
  [organization REST API](rest-api.md) takes it too, so one key serves both
  surfaces.

Organization admins see all three kinds for every member under **Settings →
Organization → API access**, with each credential's owner, access, last use
and calls per usage period, and can revoke any of them there. A connection or
token revoked that way stops working at once, and its owner sees it as revoked
by an admin under **MCP access**.

Global background curation uses the separate
[curation REST API](rest-api.md#background-curation-api) and an operator-issued
`qvc_` key. MCP accepts `qvo_`, `qvt_` and `qva_` credentials and exposes no
curation tools. Use the curation REST routes to browse images, submit source
links and record agent prechecks; final image approval and calendar assignment
remain operator actions in Qivo.

Everything below is written against *the user the credential resolves to*,
with the credential's own access as an additional ceiling on that user's
access. That ceiling is the OAuth scopes, the personal token's access or the
agent's organization role, as **Read-only credentials** below describes.

Every tool call runs as that user, through the same access layer the app
itself queries. Readable data stays within the user's access, and writes
require both the user's permission and a credential that can make changes.
Projects and sub-projects have named leads and no owning team; products can
span teams through explicit access grants. Projects can be shared with teams as well as individual users. A team grant
applies to its current members as `user` or `viewer`, and the strongest direct
or team grant wins under the organization Viewer ceiling. Grants on a project
inherit to its sub-projects; a child grant does not spill to siblings.
Removing membership removes that access path while preserving
any direct grant or access through another team. Sharing with a team's leader
does not give them ownership rights over another team's project. Manage these
grants in the app's **Project access** list or with `set_project_access`, one
user or team at a time; only a person may change them, never an agent.
Revoking a credential cuts access immediately — and so does switching the
user to **Inactive**, which stops every key or token they hold at once
without anything having to be revoked one by one: both the credential row
and the profile behind it are read fresh on every request. A request already
accepted when its credential is revoked or expires can still finish.

**Read-only credentials.** Every credential either can make changes or can
only read. One shared rule decides it (`credentialAccess` in
`convex/lib/access.ts`), and MCP, the REST API and webhook management all use
it. `get_me` reports the result as `credential.access`:

- A personal token can make changes only when it has change access and has
  not expired. The settings page sets both when the token is created, as
  described above.
- An OAuth connection can make changes only with both `qivo:read` and
  `qivo:write`.
- An agent key can make changes only when its agent's organization role is
  `user` (Standard user). A **Viewer agent** is fully read-only.

Qivo refuses every writing tool called with a read-only credential before it
resolves any reference, so the refusal reveals nothing about what exists. An
agent key gets `this agent is a Viewer and can only read` and a personal
token gets `this credential can only read`, both as the tool's error result.
A read-only OAuth connection gets the HTTP 403 `insufficient_scope` challenge
described under [OAuth protocol and deployment](#oauth-protocol-and-deployment).
A read-only credential still reads everything its user can, and
`list_projects` and `get_project` show `access.write` as `false` on every
project. It can still create, list and remove its own
[webhook subscriptions](#task-events-and-webhook-delivery).

**The Viewer role.** A user whose **organization role** is `viewer`
(migration 0102) holds a seat and signs in, reads exactly the projects they
can access directly or through a team, and changes no project, so every
project shows `access.write` as `false`. A Viewer
person's credential may be able to make changes, but every change to a task,
and every new comment, link or attachment, still refuses with the same `your
account has no write access to that project` a missing grant produces, and
they are never handed a task. Changes to a project, its access and milestones,
project creation, labels, teams and plannable hours refuse a Viewer person
with each rule's own sentence, the one anyone without that right gets, such as
`requires lead access to this project` or `only an organization admin or a
leader of one of this person's teams can set their plannable hours`. As in the
app, a Viewer person may still follow tasks, manage their own inbox and edit
or delete comments they wrote. It is a ceiling, not a grant. It opens no
project and only stops any other path (an individual or team grant, a
project-lead title, a team leadership) from exceeding read. An **agent** can
be a viewer too, which is how a read-only key is made, with one setting on the
Users page instead of a grant list audited project by project. That key's
agent is then refused as a Viewer agent, as described above. The cap lives in
the shared access layer (`cappedLevel` and `credentialAccess` in
`convex/lib/access.ts`), so the same profile is read-only over MCP, over the
REST API and in the browser alike.

Note that `viewer` is also the name of the lowest **project** role — a grant on
one project. The two are the same idea one altitude apart, which is why they
share a word; `list_users` reports the organization role as `org_role`, and
`get_project` reports project roles as the `level` of each grant.

**A token names one organization.** Since migration 0081 a login can hold a
seat in several — its own, plus any that invited it as a guest on a project
— and the app blends them into one view. MCP deliberately does not: a token
belongs to one *profile*, and every query is additionally
fenced to that profile's organization. So a token minted in your own
organization never reaches a project someone else shared with you, and vice
versa. The current settings UI mints for the home profile, falling back to
the first guest profile for a guest-only login; it has no profile selector.
OAuth displays and binds the same home profile during approval; it does not
retarget an existing connection when that login's home profile changes.
Use the browser for guest work or an admin-created agent in the target
organization for automation there. Without
that fence a bare `QN-482` would be ambiguous — task and project numbers are
per-organization — and could resolve into whichever one matched first.

Writes leave the app's usual trail: activity feed rows with that user as
actor and detail `via MCP`. An update's row names both sides of every
changed field first, e.g. `(status To Do → In Progress, remaining
80 h → 40 h), via MCP`; description edits quote both sides as ~80-char
excerpts (`description “old…” → “new…”`). Task numbers come from the
shared per-org counter. Comments are
the deliberate exception — adding one writes no activity row, matching the
app, where the comment itself is the feed entry on the discussion spine.
So is `update_user`: capacity is a setting on a person, not an event in a
project's history, and the app writes no feed row for it either.

The feed never names the credential. `delete_task` also records it in
Deleted items. Everyone who sees the deleted task there sees an agent key's
name, while a personal token's or connected app's name shows only to
organization admins and to the person who deleted.

## Request limits and billing

MCP and the organization REST API share **300 authenticated HTTP requests per
profile per minute**, across that profile's agent keys, personal tokens and
OAuth connections. A deployment-wide limit of about **6,000 requests per
minute** applies before authentication. It is kept as 16 counters of 375
requests each, and every request counts on one picked at random, so a busy
minute can be refused a little before 6,000. Both limits use fixed minute
windows. MCP limits apply
to POST requests; CORS preflights do not consume them.

Rate limiting returns HTTP `429` with `Retry-After` set to the whole seconds
left in the current minute, from 1 to 60, and the same number in its
sentence. The per-profile limit answers such as `{"error": "too many requests,
at most 300 a minute for one person or agent. Try again in 17 seconds."}`, and
the deployment-wide limit such as `{"error": "Qivo is receiving too many
requests right now. Try again in 17 seconds."}`. Wait that long before
retrying. Each authenticated POST that passes rate limiting counts as one API
call, including discovery, invalid tool arguments, permission refusals and
other protocol or routing errors. A batch is still one HTTP request. During a
paid billing period, calls count toward the organization's pooled API
allowance. Without a paid billing period, calls are counted per calendar month
(UTC) and are never charged. Missing or invalid credentials and rate-limited
requests are not counted. OAuth
MCP requests follow the same metering and limits as personal tokens and agent
keys; this does not meter authorization or token-exchange endpoints as tool
calls.

A request body may hold at most **1 MiB** (1,048,576 bytes of UTF-8). Qivo
checks the size after authentication and answers a longer body with HTTP
`413` and `{"jsonrpc": "2.0", "error": {"code": -32600, "message": "Bad
Request: a request body must be at most 1 MiB. Send less in one request."},
"id": null}`. Such a request still counts as a call.

Qivo answers a request only after its whole body has arrived, even when the
answer does not depend on it, such as a `401`, a `429` or this `413`. Once
Qivo knows such an answer, it waits at most 5 seconds more for the rest of
the body, and less when no bytes arrive for 1 second. It reads at most
32 MiB of the rest, and does not wait at all for a body whose
`Content-Length` declares more than 32 MiB. If the rest takes longer, which
for a body just over the limit means an upload slower than about 2 Mbit/s,
or the body is longer than 32 MiB, the request can end with the connection
closed, or with a `502` from the hosting front end, instead of Qivo's
answer. Treat either like a network error, and check the credential and the
body's size before you send it again. An MCP request's body that Qivo reads
to answer, such as an authenticated request's body within the limit, has no
such deadline. A client that sends `Expect: 100-continue` over HTTP/1.1 gets `100 Continue` at
once, so it sends the whole body before any answer. Over HTTP/2 the hosting
front end sends no `100 Continue`, so such a client sends the body only once
its own wait for one ends, after 1 second for curl.

The hosting front end hands a request to Qivo only once about 0.5 MiB of its
body, or about 5 seconds of a steady upload, has arrived. A body that stops
arriving before that gets no answer, and the front end resets the
connection after about 15 seconds. Treat that like a network error too.

MCP messages must be UTF-8. A body holding bytes that are not UTF-8, such as
text a client encoded as Latin-1 or Windows-1252, is answered with HTTP
`400` and `{"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse
error: the request body is not UTF-8"}, "id": null}` before any tool runs,
so it cannot store garbled text. Such a request still counts as a call.

A request's `id` must be a string, a number or `null`. Any other `id`, such
as an array or an object, is answered with HTTP `400` and `{"jsonrpc": "2.0",
"error": {"code": -32600, "message": "Bad Request: the request body is not a
valid JSON-RPC message"}, "id": null}`. A protocol error that repeats a tool
name, a method, a protocol version or an `Mcp-Method` or `Mcp-Name` header
shows at most 100 characters of it and ends a longer one with `…`. It names
an array or object by its kind, such as `Tool [object Array] not found`.
A tool's own refusal repeats a value such as a task ref in full.

When enabled organization billing has expired or needs payment, writing tools
return a readable billing refusal while reading keeps its normal access rules.
The same happens while an organization is read-only before its deletion, and
that refusal names the deletion date. Once deletion begins, every call into
the organization is refused.
An organization admin restores editing through **Settings → Organization →
Billing**, where they can subscribe, open the customer portal and inspect
usage by account and key or OAuth connection. **API access** shows each
credential's calls in the current or an earlier period. MCP does not expose
billing subscription management tools. While writes are paused, an
organization admin can still revoke any credential on **API access**, revoke
or delete agent keys and make users Inactive in the app, and people can still
revoke their own personal tokens and OAuth connections. Each of these also
stops reads with the affected credentials.

An organization admin's personal token or OAuth connection can also take
access away while writes are paused, as in the app. `set_project_access`
with `level: null` removes someone from a project, and `set_team_member`
with `member: false` removes someone from a team, when `on_held_tasks` is
`leave`, the default. Keeping them as Viewers or reassigning their tasks
writes more, so it gets the same refusal as any other writing tool until
writes are allowed again, and so does the same removal by anyone who is not
an organization admin.

## Limits

Each limit below is the same here, over REST and in the app, and the
[Limits](guide/limits.md) guide page lists every one. A text counts UTF-16
code units, the count a browser's text field uses, after Qivo trims spaces
and line breaks from both ends, and Qivo stores the trimmed text. A task
description or comment keeps the spaces that start its first line, because
Markdown reads them. Most emoji count as two. The tool schemas carry these limits as `maxLength`, `minimum`
and `maximum`, but the server checks them, so a call past one gets the
sentence in the table as its error result, the same sentence REST answers,
and changes nothing. A number outside its range is refused, never moved into
the range.

<!-- limits:start (written by scripts/limits-docs.mjs) -->

### Text

| Limit | Value | Past the limit |
| --- | --- | --- |
| Task title | 255 characters | a task title must be at most 255 characters. Shorten it. |
| Task description | 20,000 characters | a task description must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Comment | 20,000 characters | a comment must be at most 20,000 characters. Formatting counts too. Shorten it. |
| Project or sub-project name | 80 characters | a project name must be at most 80 characters. Shorten it. |
| Project description | 500 characters | a project description must be at most 500 characters. Shorten it. |
| Team name | 80 characters | a team name must be at most 80 characters. Shorten it. |
| Milestone name | 80 characters | a milestone name must be at most 80 characters. Shorten it. |
| Label name | 40 characters | a label name must be at most 40 characters. Shorten it. |
| Archive reason | 500 characters | an archive reason must be at most 500 characters. Shorten it. |
| Search text | 200 characters | a search must be at most 200 characters. Search for fewer words. |

### Files and images

| Limit | Value | Past the limit |
| --- | --- | --- |
| Attachment file name | 255 characters | a file name must be at most 255 characters. Rename the file and attach it again. |
| Attachment media type | 255 characters | a file's media type must be at most 255 characters. Send a media type such as application/pdf. |
| Attachment size | 20 MiB per file | a file must be at most 20 MiB, this organization's attachment limit. Attach a smaller file. |
| Text file from attach_text_file | 256 KiB as UTF-8 | text must be at most 256 KiB (262,144 bytes) as UTF-8. Split it into several files. |

### Tasks and organizations

| Limit | Value | Past the limit |
| --- | --- | --- |
| Active subtasks per task | 100 active subtasks | the parent task already has 100 active subtasks, the most a task can have. Archive or remove one of them first. |
| Subtasks a move to another project carries | 200 subtasks, archived ones included | this task has more than 200 subtasks, archived ones included, and a move to another project carries them all. Restore some archived subtasks and remove them from this task first, or move it within its project. |
| Attachments per task | 100 attachments, description images included | this task already has 100 attachments, images in its description included, the most a task can have. Remove one first. |
| Links per task | 100 links | this task already has 100 links, the most a task can have. Remove one of its links first. |
| Labels per task | 20 labels | this task already has 20 labels, the most a task can have. Remove one first. |
| Followers per task | 100 followers | this task already has 100 followers, the most a task can have. Someone must unfollow it first. |
| People mentioned in one text | 100 people | a text can mention at most 100 people. Remove some mentions and save again. |
| Tasks one access removal reassigns | 120 tasks | a removal can reassign at most 120 tasks at once, fewer when the change is too large for one request. Keep the people as Viewers or reassign some of the tasks first. |
| People with open tasks one access removal settles | 700 people | a removal that keeps people as Viewers or reassigns their tasks can take access from at most 700 people with open tasks at once. Leave the tasks with them, or remove some of the team's members first. |

### Numbers and settings

| Limit | Value | Past the limit |
| --- | --- | --- |
| Plannable hours per week | 1 to 168 hours | plannable hours per week must be a whole number of hours from 1 to 168. |
| Remaining hours of a task | 0 to 99,999.9 hours | remaining hours must be a number from 0 to 99,999.9. Enter a number in that range. |
| Review hours of a project | 0 to 999 hours | review hours must be a number from 0 to 999. Enter a number in that range. |
| Snooze | 366 days ahead | a snooze can be at most 366 days ahead. Pick an earlier time. |

### REST and MCP requests

| Limit | Value | Past the limit |
| --- | --- | --- |
| Tasks per list page | 1 to 200 tasks | limit must be a whole number of tasks from 1 to 200. |
| Inbox items per list page | 1 to 200 items | limit must be a whole number of items from 1 to 200. |
| Comments per list page | 1 to 50 comments | limit must be a whole number of comments from 1 to 50. |
| Workload weeks | 1 to 52 weeks | weeks must be a whole number from 1 to 52. |
| Tasks per inbox change | 100 tasks | tasks must name at most 100 tasks per call. Send the rest in another call. |
| Webhook subscription lifetime | 60,000 to 604,800,000 milliseconds | ttlMs must be a whole number of milliseconds from 60,000 (1 minute) to 604,800,000 (7 days), or null for no expiry. |
| Webhook subscriptions per organization | 100 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook subscriptions per agent key, token or OAuth connection | 20 subscriptions | an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first. |
| Webhook callback URL | 2,048 characters | a callback URL must be at most 2,048 characters. Use a shorter URL. |
| Event subscription request | 16,384 characters | an event subscription request must be at most 16,384 characters. Send fewer or shorter parameters. |
| Request body | 1 MiB | a request body must be at most 1 MiB. Send less in one request. |
| Requests per person or agent | 300 requests per minute | too many requests, at most 300 a minute for one person or agent. Try again in 60 seconds. |

<!-- limits:end -->

## Connecting Claude

For an OAuth-capable remote MCP client, add `https://api.qivo.io/mcp` and start
its browser authorization flow. Qivo asks the person to sign in and approve
the named client, organization and requested access. The default request
includes reading, changes and automatic renewal. **Allow changes** starts
checked for a write request; turning it off narrows access to reading only.
The client handles code exchange and credential storage; users do not paste
secrets. The app name is
client-supplied, so users should approve only a flow they initiated.

Clients with custom-header support can keep using the following manual setup.

Claude Code:

```sh
claude mcp add --transport http qivo \
  "https://api.qivo.io/mcp" \
  --header "Authorization: Bearer qvt_…"
```

(The settings page offers this command pre-filled with your fresh token.)

Claude Desktop and other clients that take a JSON config with headers:

```json
{
  "mcpServers": {
    "qivo": {
      "type": "http",
      "url": "https://api.qivo.io/mcp",
      "headers": { "Authorization": "Bearer qvt_…" }
    }
  }
}
```

OAuth supports authorization code with S256 PKCE and dynamic client
registration. Client ID Metadata Documents and device-code authorization are
not implemented. Client-specific compatibility should be checked against
these mechanisms; support is not a claim that every assistant has been tested.

## OAuth protocol and deployment

Browser clients can register and exchange, inspect or revoke tokens across
origins. Public CORS applies only to those four machine endpoints, which
ignore session cookies and return no credentialed CORS headers. Browser
sign-in, consent and operator routes retain the app-origin restrictions.

Dynamic client registration needs no credentials, so Qivo limits it. Each
source address may send **60 registration requests per hour**, and the whole
server accepts **600 per hour**. An IPv6 address counts as its /64 network,
and each IPv6 /48 network may send at most **120 per hour** over all of its
/64 networks. All limits use fixed hourly windows. Past any limit, registration
returns HTTP `429` with `Retry-After` set to the seconds left in the hour.
When Qivo cannot check the limits, it refuses the registration with HTTP
`503` and `Retry-After: 60`. Client metadata may be at most 8 KiB of JSON;
larger registrations get HTTP `400` with `invalid_client_metadata`, and one
whose body is over 64 KiB gets HTTP `413` (see below). A registration that
succeeds answers HTTP `201`. Every client Qivo registers is public: it uses
PKCE and gets no secret, and its `token_endpoint_auth_method` is `none`
whatever the registration asked for. Registration takes no initial access
token and ignores an `Authorization` header. Each redirect URI must be
absolute, with no fragment and no user name or password. A registration
whose redirect URIs are all `https` on hosts other than loopback registers a
`web` client. One with a redirect URI to `http://localhost`,
`http://127.0.0.1` or `http://[::1]` (any port and path), or with a
private-use scheme, registers a `native` client. A private-use redirect URI
is either a scheme with a period and no host, such as
`com.example.app:/callback`, or a scheme with a host and a path, such as
`cursor://anysphere.cursor-retrieval/oauth/callback`. Any other redirect URI
gets HTTP `400` with `invalid_redirect_uri`, for example `myapp://callback`
(no path), `myapp:/callback` (no period), `http://localhost./callback`,
plain `http` on any other host, and a loopback URI in a registration that
asks for `"application_type": "web"`. Qivo issues Bearer tokens
only and does not support DPoP: the token endpoint ignores a `DPoP` header,
an authorization request with `dpop_jkt` gets `invalid_request`, and a
registration's `dpop_bound_access_tokens` is dropped. Register
once and keep the client ID. A daily cleanup deletes a client that nobody
approved on its first run after the client turns three days old, which is
three to four days after it registered. A client stays while a consent, a
token, an approved connection or a pending authorization refers to it. After
the cleanup deletes a client, its next authorization request fails with
`invalid_client` and the client must register again. Qivo serves no other
client management endpoints, so a client cannot be changed after it
registered.

The MCP endpoint advertises its protected-resource metadata in
`WWW-Authenticate` on HTTP 401, and serves
`/.well-known/oauth-protected-resource/mcp` plus the root alias. The metadata
names the canonical MCP resource and authorization server. Use those values
for discovery instead of guessing authorization or token endpoints.
The authorization server's metadata is at
`/.well-known/oauth-authorization-server/api/auth`, at the root alias
`/.well-known/oauth-authorization-server` and at
`/api/auth/.well-known/oauth-authorization-server`. Qivo publishes no OpenID
Connect discovery document, so the `openid-configuration` locations get HTTP
`404`. Qivo serves the endpoints that metadata names and the browser sign-in
and consent routes. Every other path under `/api/auth` gets HTTP `404`, for
example an OpenID Connect userinfo or end-session request.
The initial 401 challenge advertises
`scope="qivo:read qivo:write offline_access"` so clients following it request
normal task access and automatic renewal. A client can request a smaller
scope set, and consent can remove write access. Authorization sends a login
that belongs to no organization to the consent page, which says why and what
to do next. Consent refuses such a login, or one whose organization seat left
after the consent page opened, with `403` and `access_denied`. Its
`error_description` says why and what to do next, and the refusal grants
nothing and issues no code.

`MCP_RESOURCE_URL` defaults to `CONVEX_SITE_URL + /mcp`. Set it explicitly to
`https://api.qivo.io/mcp` for the public custom domain, whose metadata paths
must reach the same Convex backend. The issuer is `CONVEX_SITE_URL + /api/auth`
and the browser consent page uses `SITE_URL + /app/~/connect`. Changing the
canonical resource requires approving new connections. See `.env.example`.

Authorization requests use `response_type=code`, S256 PKCE, an exactly
registered redirect URI, scopes and the canonical `resource`. Token and
refresh requests should specify that same single resource. For compatibility,
an omitted resource selects this sole canonical default; foreign or repeated
values are refused. `qivo:read` permits
discovery and reading; `qivo:write` permits writing subject to current account
and project permissions. `offline_access` requests automatic renewal and is
an authorization-server scope. Read-only grants receive HTTP 403 with
`insufficient_scope` when attempting a writing tool, on either MCP protocol
leg. OAuth tokens also support REST webhook management. They are refused by
other REST routes and background curation, so an OAuth connection attaches
files with the MCP upload tools (see [Attachments](#attachments)).

A request to the authorization server, such as a registration, token or
revocation request, may hold a body of at most 64 KiB. Qivo waits at most 5
seconds for it, counted from when the hosting front end hands the request
on. A longer body is answered with HTTP `413` and a slower one with HTTP
`408`, each with `{"error": "invalid_request", "error_description": "..."}`
naming the reason. A client still sending its body may get the connection
closed or reset instead of the `408`, and a body that stops before the front
end hands it on gets no answer (see
[Request limits and billing](#request-limits-and-billing)). Treat those like
a network error. Send the request again with a shorter body or over a better
connection.

A registration whose metadata has the wrong form, such as a number in
`redirect_uris`, is answered with HTTP `400` and `{"error":
"invalid_redirect_uri", "error_description": "redirect_uris[0] must be a
string"}`. The token, revocation and introspection endpoints answer the same
way. The description names the first problem and its place in the body. Fix
what it names and register again.

Each approval has an immutable user, profile, organization, client and
resource binding. Revocation, inactive or removed membership, and the
provider token's expiry are checked when authenticating requests. Deleting a
connection prevents access and refresh and hides the grant from the person's
list. Signing out of the browser session that approved a connection ends the
access tokens issued in that session, so the client's next request gets HTTP
`401`; its refresh token, which `offline_access` keeps, renews access without
a new approval. Its revoked grant and replay hashes are retained so old signed consent
and credentials cannot revive it. Reuse of a consumed code or refresh token revokes the
connection, including credentials issued by a concurrent refresh; clients
must serialize refresh requests. A fresh connection creates a new grant.

The OAuth provider is Better Auth `1.7.12`, which fixes the resource-binding
advisory [GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528)
of the 1.6 line: the provider binds each grant to the resource it was
approved for. The MCP endpoint is the one resource Qivo configures. Qivo also
checks resource parameters and stores an immutable resource binding on each
grant; regression tests cover foreign and repeated resource indicators and
the canonical default when omitted. Do not add another resource without
revisiting these checks. [Better Auth and Qivo's copy of the Convex
adapter](better-auth-upgrade.md) describes the release Qivo runs and how to
move to a later one.

## Protocol revision

This server speaks **2026-07-28**, the revision that made statelessness the
protocol's own rule rather than one deployment's choice. **If you connect with
a current client there is nothing to do** — the paragraph after next explains
why. What changed, for anyone writing against the endpoint directly:

- **No handshake.** `initialize` and `notifications/initialized` are gone.
  Every request carries its own context in `params._meta`:
  `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities` are required,
  `io.modelcontextprotocol/clientInfo` should be there. The `protocolVersion`
  key doubles as the leg selector: a request carrying it is judged by this
  revision's rules, and one **without** it is indistinguishable from a
  2025-era request, so it takes the backward-compatible leg below — no
  refusal, the old grammar. On this revision's leg a missing
  `clientCapabilities` is refused with `-32602`, and an unsupported
  `protocolVersion` value with `-32022`, naming the versions the server does
  support; the server is not allowed to remember the last one.
- **The headers mirror the body.** `Mcp-Method` on every POST, plus
  `Mcp-Name` carrying `params.name` on `tools/call`, so a proxy can route
  without parsing the body. Disagree with the body and the request is refused
  `400` with `-32020` (`HeaderMismatch`) — including when a required one is
  simply missing. Those two are the only headers enforced: the protocol
  version is read from the body envelope, never from a header (the lowercase
  `mcp-protocol-version` on the CORS allow-list is a courtesy to clients
  that send it, not a check).
- **`server/discover`** answers what `initialize` used to: supported versions,
  capabilities, identity. Identity also rides in *every* result's `_meta` as
  `io.modelcontextprotocol/serverInfo`, since no client can be assumed to have
  asked. Every result carries a `resultType`, `"complete"` for all of ours.
- **`tools/list` and `server/discover` are cacheable.** Both come back with
  `ttlMs` (an hour) and `cacheScope: "private"`. The tools are
  identical for every credential, but the response sits behind a bearer
  token, so cache it per client and never in a shared cache. Stop re-listing
  on every turn.
- **No sessions, no server-initiated stream.** `Mcp-Session-Id` is gone (sent,
  it is ignored — never minted, never echoed), and so are the GET stream and
  the DELETE that ended a session: both verbs answer `405`. Streams are not
  resumable, so `Last-Event-ID` does nothing. `ping` and `logging/setLevel`
  were removed from the protocol and answer `404` with `-32601` on this leg
  (a 2025-era client's `ping` still works — see below).
- **Not offered here:** `subscriptions/listen` (no resource-notification
  stream), the Tasks extension, and multi-round-trip requests —
  no tool asks the caller for anything mid-call, so no result is ever
  `input_required`.

**2025-era clients keep working.** Every client shipping today still opens
with `initialize`, so a request without the `protocolVersion` envelope is
served by the revision's own backward-compatible leg: `initialize` (echoing
a supported 2025-era revision), `ping` (answering `{}`), `tools/list` and
`tools/call`, the same tools, one fresh server per request. That leg
also keeps the old framing: each response is a single SSE `event: message`
frame, behind the Accept header the 2025 protocol required (it must name
both `application/json` and `text/event-stream`, or the answer is `406`);
the modern leg is plain JSON with no Accept gate. All of it is a deliberate
setting, not a leftover: refusing old clients would be the stricter reading
of the revision and would disconnect every current user. It is also why
`mcp-session-id` is still on the CORS allow-list — a 2025-era browser client
mints one, and this server ignores it.

## Task events and webhook delivery

Qivo supports the draft MCP Events extension through `events/list`,
`events/subscribe` and `events/unsubscribe` on the modern MCP protocol leg
(`2026-07-28`). `server/discover` advertises `events: {}`. These are protocol
methods, not additional tools. Legacy tool clients keep their existing behavior.
The contract follows [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
and its [draft specification](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md).
Client support is required. Connecting a tool-only MCP client does not make it
receive events or start work automatically.

Available events are `task.created`, `task.updated`, `task.deleted`,
`task.restored` and `comment.created`. `task.deleted` means the task moved to
Deleted items, and `task.restored` that a person restored it there.
`task.updated` covers stored task-field changes made through
the app, REST and MCP model paths, subtree archiving, the subtasks a move
carries to another top-level project, restoration, automatic
archiving and profile-removal cleanup. No-op updates do not emit events. A
group's dates are calculated from its subtasks, so a subtask date change emits
no event for the group. Comment edits/deletes, labels, links, attachments, project
changes and seed/import writes do not have event types in this version.
Deleting or restoring a project, deleting an organization and deleting work
for good from Deleted items deliver no events for their tasks. Deleting a
project can still emit `task.updated` when it detaches a child task in a
surviving project.

Optional `arguments.task_id` and `arguments.project_id` filters take UUIDs,
not QN refs or project keys. A project filter must name a task-containing
sub-project. A parent meta-project is refused because it cannot contain tasks;
filters do not expand child projects. With no filters, Qivo monitors matching
events from projects the subscribing account can read. Both filters together must identify
a task in that project. A task move is delivered only when the subscriber can
read both its previous and new project. Project filters match the destination
project on a move; a task moving out of the filtered project no longer matches.

For direct requests, send `Mcp-Method` matching the JSON-RPC method on every
POST. For example, `events/subscribe` requires `Mcp-Method: events/subscribe`;
`events/list` and `events/unsubscribe` require their corresponding header values.
Include the normal authentication, JSON content type and MCP `_meta` envelope.

Example `events/subscribe` params, in addition to that envelope:

```json
{
  "name": "task.updated",
  "arguments": { "task_id": "<task UUID>" },
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example/qivo",
    "secret": "whsec_<base64-encoded signing key>"
  },
  "cursor": null,
  "ttlMs": 86400000
}
```

Only `webhook` delivery is offered. Callbacks require public HTTPS on port 443,
without URL credentials, fragments or redirects. Qivo validates every resolved
address and pins validated addresses when opening the TLS connection. It can
try another validated address during TCP connection setup, but does not resend
an HTTP request after transmission starts. Local, private, reserved and
Tailscale addresses are refused. IPv6 destinations must be global unicast
addresses within `2000::/3`. TLS hostname verification remains enabled.
The signing secret must use the Standard Webhooks `whsec_` prefix and canonical base64 encoding of
24 through 64 bytes. Qivo encrypts stored signing secrets using AES-256-GCM and
a key derived from the deployment's `BETTER_AUTH_SECRET`, bound to the
subscription ID. Changing that deployment secret requires recreating webhook
subscriptions. Subscription listings and organization exports reveal no secrets.

Before activation, the callback receives a signed verification request:

```json
{ "type": "verification", "challenge": "<random challenge>" }
```

It must return a `2xx` JSON response containing the same `challenge`.
Verification failure returns MCP error `-32015` with a categorized reason;
invalid input returns `-32602`. Reasons are `connection_refused`, `timeout`,
`tls_error`, `http_4xx`, `http_5xx` and `challenge_failed`. A `2xx` with invalid
JSON or a missing or mismatched challenge is `challenge_failed`. Verification
responses must finish within the callback deadline and stay within 64 KiB.
Qivo does not store an active subscription if verification fails. Every refresh verifies the callback again. Subscription
identity combines the authenticated credential record, event name, canonical
filters and normalized callback URL, so repeated subscriptions refresh one row.

Other event-method errors use the draft extension codes:

| Code | Meaning |
| --- | --- |
| `-32011` | Unknown event or missing/inaccessible filtered task or project |
| `-32012` | The credential or requested operation is no longer authorized |
| `-32013` | Subscription quota reached |
| `-32014` | Unsupported delivery mode or replay cursor |
| `-32603` | Server configuration or unexpected internal error |

Personal tokens and agent keys own separate subscriptions, even for the same
account. OAuth subscriptions belong to the approved connection grant. Access
tokens issued for that grant share its subscriptions; token expiry, rotation or
revocation of an individual access token does not cancel them. Disconnect the
connected app or unsubscribe to stop its subscriptions. An OAuth connection
created after disconnecting is a new owner and cannot recover the old grant's
subscriptions.

Refreshing an unexpired subscription preserves pending deliveries and retries.
Registering after deletion or expiry starts a new registration, so queued events
from the previous registration cannot be delivered through its replacement.

The response includes `id`, `refreshBefore`, `cursor: null` and `truncated: false`.
On MCP, omitting `ttlMs` requests seven days. `ttlMs` is a whole number of
milliseconds from 60,000 (one minute) to 604,800,000 (seven days). Any other
number is refused with `-32602` and `ttlMs must be a whole number of
milliseconds from 60,000 (1 minute) to 604,800,000 (7 days), or null for no
expiry.`, and so are params that hold a number too large for a double, such
as `1e309` (`-32602`, `Invalid params: a number is too large to represent`).
Until October 2026 Qivo moved a value outside the range to its nearer end.
Send `ttlMs: null` for no expiry. Qivo returns `refreshBefore: null` for
these subscriptions, which need no renewal. REST defaults to no expiry when
`ttlMs` is omitted, as webhook APIs usually do. Existing subscriptions keep
their stored expiry until registered again.
Each registration applies these rules, so an MCP renewal that omits `ttlMs` sets
a new seven-day expiry even if the subscription previously had no expiry.
Renew finite subscriptions before `refreshBefore`. There is no replay; non-null
cursors are refused. Events occurring without an active subscription cannot be
recovered through this interface. Limits are 20 unexpired subscriptions per
credential or OAuth grant and 100 per organization, including disabled
subscriptions retained for inspection. A subscription past either is
refused with `-32013`, `data: {"limit": "subscriptions"}` and `an organization
can have at most 100 unexpired webhook subscriptions, and one agent key, token
or OAuth connection at most 20. Delete an unused subscription first.` REST
answers it as HTTP `409`.
Delete unwanted subscriptions to release that capacity. Registration automatically
removes expired registrations and reclaims capacity held by subscriptions whose
credential was revoked, expired or deleted, or whose account was removed. Temporary
deactivation and lost project access do not remove subscriptions. A personal
token's subscriptions stop delivering when the token expires, and the next
registration in the organization removes them.

Each delivery contains one event:

```json
{
  "eventId": "<event UUID>",
  "name": "task.updated",
  "timestamp": "2026-10-04T12:00:00.000Z",
  "data": {
    "task_id": "<task UUID>",
    "task_ref": "QN-482",
    "project_id": "<project UUID>",
    "actor_id": "<profile UUID>",
    "changed_fields": ["status"]
  },
  "cursor": null
}
```

`actor_id` is null for maintenance and profile-removal cleanup. Payloads carry
identifiers and changed field names, not task titles, descriptions or comment
bodies. Use the existing read tools to retrieve current content. Creation,
deletion, restore and comment events use an empty `changed_fields` list. A
deleted task cannot be fetched while it is in Deleted items. After
`task.restored` it can, with the same uuid and key. `changed_fields` contains stored task-column names,
including server-maintained fields such as `remaining_set_at`. These names do
not form an API write payload. Names can include `created_by`, `done_at`,
`review_at`, `start_week`, `end_week` and `parent_id`. For example, the event
reports `archived_at`, while a machine API write uses `archived`. A move to
another sub-project lists `done_at` and `review_at` next to `project_id` for
a task whose Done time or review hand-off the move restarts. Changes only
to `updated_at` are excluded.

An integration receives matching events from its own writes. Receivers that
write back to Qivo must prevent feedback loops through idempotent changes or
processed-work tracking. They can use `actor_id` to ignore their own actor when
that fits the integration. Deduplicating by `eventId` alone does not prevent a
loop that creates a new event on each write.

Verify deliveries with Standard Webhooks using `webhook-id`,
`webhook-timestamp` and `webhook-signature`. `webhook-id` equals `eventId` for
application events. `X-MCP-Subscription-Id` identifies the subscription. Signatures
cover the event ID, signing timestamp and exact body bytes. Secret refreshes
allow signatures from both the old and new key for five minutes. Refreshing again
with the same key preserves that old key and the original grace deadline,
including the first refresh of a subscription stored before keyed secret hashes
were introduced.

Task writes commit with durable event records containing the subscriptions that
matched at the time of the change. Background workers expand these records into
deliveries in bounded batches, then send callbacks with durable leases. A new
subscription or newly granted project access cannot collect earlier events. Qivo
checks credential validity, account activity and project visibility when recording
the match, before creating a delivery and before attempting it. Move events retain
the previous project so both project permissions can be rechecked. Recurring
recovery resumes unfinished event expansion and delivery after worker or scheduler
failures, including work that never reached its first attempt. Shared background
reservations combine wake requests into one expansion worker and one dispatcher.
Each worker atomically hands its reservation to the next generation or releases
it; stale generations do no work. Task transactions do not read these shared
reservations. Dispatch permits at most five queued or running callback workers
per organization and one per subscription. Scheduled callback job IDs prevent
a queued or running callback worker from being duplicated
merely because a dispatch interval elapsed. Dispatch continues immediately for
due work or one coalesced wake received while its reservation is active. That
fresh run prevents work arriving after the current transaction's snapshot from
being missed. Completion and terminal refusal wake waiting work; retry timers
and recurring recovery handle future deadlines without multiplying dispatch
chains. Routine acknowledgments and failures update separate health records. They do not rewrite the subscription documents
read during task changes and outbox expansion; disabling delivery updates the
subscription because it changes eligibility. Disconnecting OAuth, revoking/deleting
a key, removing project access, unsubscribing or expiration stops subsequent
attempts. A request already in flight may still arrive. Pending events for a
task moved into an unreadable project are dropped.

A `2xx` acknowledges receipt, not completion of agent work. Event delivery
accepts the HTTP status without waiting for a response body. Transient failures
receive up to eight total attempts, including the first. The seven retry delays
are 10, 20, 40, 80, 160, 320 and 640 seconds, totaling 21 minutes 10 seconds.
Request duration and queue delays add to that elapsed time. The retry budget is
separate from the seven-day subscription health rule below. Retries preserve
`eventId` and body bytes but use a fresh signing timestamp. `408`, `425` and
`429` retry; other `3xx`/`4xx` responses stop that delivery. `410 Gone` stops only the event and leaves the subscription and
its failure streak unchanged. Deliveries can be duplicated or out of order;
receivers must deduplicate by `eventId`. Completed delivery state
is retained for seven days. The 15-minute retention job removes expired
subscriptions and old completed state in bounded pages, scheduling continuations
when more rows remain. There is no delivery-history API or manual replay in
this version.

The delivery registration binding and dispatch timestamp are optional schema
fields so existing deployments can upgrade without a reset. Recovery marks old
queued deliveries without a registration binding as failed, since their
subscription ID may have been reused. Legacy move events without a stored
source-project binding also fail closed. Existing subscriptions survive and
new events deliver normally. These retired events are not replayed. Existing
health fields remain readable until the first health update creates a separate
health record. That record owns cleared fields too, so an old failure streak
cannot reappear after recovery. Removing a registration also removes its health.

A failed attempt other than `410` starts a failure streak. A `2xx` acknowledgment
clears it. If another attempt fails at least seven days after the streak began,
without an intervening acknowledgment, Qivo disables the subscription and stops new
queues and further attempts. One failed event that exhausts its retries does
not disable the subscription by itself. Quiet subscriptions remain active;
Qivo sends no periodic health probes. A finite subscription can expire before
another failure reaches this health window; renew it before expiry to keep it
active. The default seven-day MCP lifetime does not extend automatically.
A receiver acknowledging events while ignoring their contents cannot be detected through this mechanism.

Disabled subscriptions remain visible through REST `GET /v1/webhooks`, with
`status: "disabled"`, `disabled_reason: "delivery_failures"`, `disabled_at`,
`failed_since`, `last_failure_at`, `last_success_at` and `last_status`.
Timestamps and unknown HTTP statuses use null when absent. Status zero records
an attempt without an HTTP response, including a connection or local delivery
error. Renewing an active subscription verifies the callback without clearing
its failure streak or any health history. Replies already in flight still
contribute to that active subscription's health.

Repeating `events/subscribe` or REST POST for a disabled subscription verifies the
callback, re-enables delivery and clears `failed_since` and the disabled fields.
It preserves `last_success_at`, `last_failure_at` and `last_status` as history.
Failed verification leaves it disabled. Replies from attempts started before
this recovery cannot change the recovered subscription's health. Those requests
can still acknowledge their event or retry a transient failure using the refreshed
registration. Previously failed events are not replayed.

Use the same personal token, agent key or a current OAuth access token from the
owning grant with REST `GET /v1/webhooks` to inspect health. MCP `events/list`
lists event definitions, not subscriptions. Organization administrators can use
REST `GET /v1/webhooks/organization` and `DELETE /v1/webhooks/organization/{id}`
to inspect and reclaim shared quota with a personal token or OAuth connection.
Deleting another owner's subscription needs a credential that can make
changes: a personal token with change access, or an OAuth connection with
`qivo:write`. A read-only personal token gets HTTP 403 with
`this credential can only read` there, and a read-only OAuth connection gets
HTTP 403 with `OAuth connection does not have the required scope`. Managing
your own subscriptions, and
listing the organization's, works with a read-only credential too, so OAuth
needs only `qivo:read` for them.

For `events/unsubscribe`, send the original event name, arguments and
`delivery: { "url": "<original callback URL>" }`. The optional `mode` field may
be `"webhook"`. The secret is unnecessary. Unsubscribe is idempotent and returns
an empty result.
Webhook subscriptions persist in the database; the MCP handler remains
stateless and does not add sessions, GET streams or `subscriptions/listen`.

## Tools

Task refs are **permanent**: `QN-482` (any case), bare `482`, or the task
uuid — task numbers are org-scoped (one counter per organization, migration
0050), assigned at creation, and survive moves between sub-projects and
project renames. Project refs are a per-org project number, a key like `ENC`
(the app has no screen that changes a key, but prefer numbers/uuids in
anything stored), or a uuid.
The website, MCP and REST share the same noun: **task** for one work item
and **tasks** for collections. MCP uses `list_tasks` for the collection and
`get_task`, `create_task`, `update_task`, and `delete_task` for individual
operations, `set_task_link` for links between tasks, `list_labels` and
`set_label` for the organization's labels, `start_attachment_upload`,
`confirm_attachment_upload`, `attach_text_file` and `delete_attachment` for
a task's files, `list_task_activity` for its history, `get_workload` for
planned hours per person, `update_comment` and `delete_comment` for comments,
`list_inbox` and `update_inbox` for your inbox, `set_following` to follow a
task, `get_project`, `create_project`, `update_project`,
`set_project_access`, `set_milestone` and `delete_milestone` for projects,
and `set_team` and `set_team_member` for teams. This pre-launch rename
replaces the former tool names; clients
with a cached tool catalogue must refresh discovery or reconnect.

A refused tool call answers its refusal sentence as the tool's error result
(`isError: true`). A call whose change keeps conflicting with changes other
calls make to the same data at that moment, such as many comments posted to
one task at once, answers `the request conflicted with other changes made at
the same time and changed nothing; send it again` there. Qivo first retries
the change itself, twice at most, and answers this only when none of it was
saved, so wait a second and make the same call again. A change that keeps
running out of time, which a busy server and such conflicts can cause, is
retried the same way and answers `the request took too long and changed
nothing; send it again, or change less at once if it keeps happening`,
which you handle the same way. A change too large to finish in time runs
out every time, so if the time out repeats, split the change into smaller
calls. A conflict or time out before the tool runs, while Qivo counts or
authenticates the request, is an HTTP `503` with `Retry-After: 1` and the
matching sentence as `error`, and the request is safe to send again in the
same way. A call that sent `expected` and is refused because someone
changed one of those fields since answers a sentence that ends `so nothing
was saved; read <record> again and resend your change`, or for a delete `so
nothing was deleted; read <record> again before you delete it` (see [Refusing a
change when a field changed since you read
it](#refusing-a-change-when-a-field-changed-since-you-read-it)). Unlike the
conflict above, never make that call again unchanged, because Qivo refuses
it again. Read the record, decide whether your change still applies, and
send it with the values you read now. A failure that is not a refusal, such as a server limit, answers `internal error` there instead, and outside a tool call
it is an HTTP `500` with the same error. Qivo keeps its details in its own
logs. `internal error` does not say whether a change was saved, so read the
task or list before you make a changing call again.

Qivo checks the arguments against the tool's schema before the tool runs.
An argument the schema does not know is refused, and the call changes
nothing. For example, `set_project_access` with a misspelled `on_held_task`
answers `Input validation error: Invalid arguments for tool
set_project_access: Unrecognized key: "on_held_task"`, and several unknown
arguments read `Unrecognized keys: "a", "b"`. The list names at most 10
arguments and then counts the rest, such as `and 5 more`. A name longer than
100 characters is cut and ends with `…`. `arguments` must be a JSON
object, or absent or `null` for none. Any other value is refused, for
example `Invalid input: expected object, received string`. Only the
tools that take no arguments, `get_me`, `list_teams`, `list_users` and
`list_labels`, ignore what they are sent. The schema check covers each
argument's type, its allowed values and the pattern of a uuid or a date. A
text's length, a number's range and a list's size are the server's checks,
which answer the limit's sentence from [Limits](#limits) as REST does, such
as `a task title must be at most 255 characters. Shorten it.`

| Tool | What it does |
|---|---|
| `get_me` | Who the credential acts as, as `user` (the `list_users` row plus `email`, `null` for an agent), `organization`, `billing` and `credential`. See [Who am I](#who-am-i). Call it first |
| `list_teams` | Teams in your organization, as `id`, `name` and `members` (`id`, `name`, `leader`, by name). Teams group users for project sharing and administration. A team's project grants are in `get_project`, and `list_project_users` shows who has access through them. Neither project type has an owning team (renamed from `list_workspaces` by migration 0078). See [Teams](#teams) |
| `list_projects` | Projects (meta + sub) you can see, each with its durable `num`; both types have a lead and a nullable legacy `team_id` that is `null` for new rows, while team sharing remains explicit access; ACTIVE ones by default — `archived: true` lists the ones that have been put away instead (0106). Each row has `archived` and your `access` (`read`, `write`) on that project, as REST's rows do. See [Projects, access and milestones](#projects-access-and-milestones) |
| `list_tasks` | Filter by `project` (number/key/uuid; metas include their subs), `status` (one status or a list of them), `priority`, `assignee_id`, `owner_id`, `search` (all word fragments across the fields the app's task filter searches: task ID, title, description, status name except on a task with subtasks, priority name, assignee name and label names; case-insensitive and in any order; `*` stays literal), `limit` (50 by default, at most 200) and `offset`; every result includes reporter, assignee, reviewer and owner. `assignee_id` matches the stored assignee, also while a reviewer owns the task; `owner_id` matches whose work it is, the reviewer while the task is in review with one and the assignee otherwise. Every result also has `progress` (for a group, the done and total tasks without subtasks under it that you can see), `delay` (the app's projected delay when the task's project tracks it) and `last_comment_at`. Active tasks only by default, oldest first by creation, so `offset` pages through them. `archived: true` lists archived tasks instead (0070), one `project` at a time with all its sub-projects you can read, as `{next_cursor, tasks}` paged with `cursor` (see [Task results](#task-results)). Tasks in an ARCHIVED PROJECT are left out of active lists unless `project` names that project (0106). That is a different axis, and the one without a flag |
| `get_project` | One readable `project` (number/key/uuid), as the `list_projects` row plus `lead_id`, `lead_name`, `review_hours` (its own, `null` when it uses its parent's or the default), `effective_review_hours`, `track_delay`, `completion` (the Overview's done and total tasks), the top-level project's `milestones` and its own `grants`. See [Projects, access and milestones](#projects-access-and-milestones) |
| `create_project` | Create a top-level project from `name` (at most 80 characters), or with `parent` (number/key/uuid) a sub-project; optional `lead_id` (you by default) and `description`. Answers like `get_project` |
| `update_project` | Change a project you lead: `name` (at most 80 characters), `description`, `review_hours`, `track_delay`, `archived: true/false` to archive or restore it, and `lead_id` to hand over the lead (people only). Answers like `get_project`. It takes no `archive_reason`, which only tasks take. `expected` holds what you last read of the fields it changes, `lead_id` as `get_project` shows it. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `set_project_access` | Give one `user_id` or `team_id` `level` `user` or `viewer` on a `project`, or with `level: null` remove it, settling the open tasks it hides by `on_held_tasks`. People only, with Lead access. With a level, `expected` holds the `level` you last read in `get_project`'s `grants`, `null` for none; with `level: null` it is refused. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `set_milestone` | Add a milestone (`name` of at most 80 characters, `date`) to a `project`'s top-level project, or with `milestone` rename or move one; then `expected` holds the `name` and `date` you last read of the fields it changes. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `delete_milestone` | Delete a `milestone` of a `project`. `expected` holds the `name` and `date` you last read, either or both. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `set_team` | Without `team_id`, create a team called `name` (at most 80 characters, organization admins only); with `team_id`, rename it (an organization admin or a leader of the team), and then `expected` holds the `name` you last read. Answers the `list_teams` row with `created`. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `set_team_member` | Add (`member: true`) or remove (`member: false`) one `user_id` in a team, and with `member: true` make or unmake them a leader (`leader`). People only, as an organization admin or a leader of the team. A removal settles the user's open tasks by `on_held_tasks` |
| `list_users` | Every Qivo user in the organization, for general roster discovery. The row is `id`, `name`, `org_role`, `kind`, `active`, `plannable_hours` — no email address and no profile picture. Presence here does **not** prove access to a destination project; use `list_project_users` before writing `reporter_id`, `assignee_id` or `reviewer_id`. `plannable_hours` is the **whole** hours a week that user has for **planned project work** (the work week minus meetings and other overhead). It is what the planner divides by: plan someone at most that many hours in a week, shared across every project they work on (0092). It is **`null` for an agent** (0103), whose capacity is unbounded, never zero |
| `list_project_users` | Users with access to `project` (number/key/uuid), and therefore valid non-null `reporter_id` values. On a parent project these are the people with access to the parent itself (organization admins, its lead and its individual or team grants); someone who reaches the parent only through one of its sub-projects is listed under that sub-project. It returns the `list_users` shape plus `assignable`: only active users with effective project Edit (`user`) or Lead access have `assignable: true` and are valid new `assignee_id` or `reviewer_id` selections. Inactive users and users with only View access remain valid reporters when they can see the project, because reporter is attribution rather than work or permission |
| `get_task` | One task with full description and reporter, assignee and reviewer, `progress` for a group, `delay` and `last_comment_at`, plus its `labels`, `subtasks` (with `has_more_subtasks` when an archived task has more than one call lists), `links`, `following`, `followers`, `attachments` with download links and, for a group, `group_remaining_hours` (see [Task results](#task-results)); `ref` is `QN-482`, `482`, or a uuid. It resolves archived tasks too (`archived_at` is non-null on them) |
| `list_comments` | The task's newest comments, oldest first, with author and edit attribution. `limit` (50 by default, at most 50) caps how many, and `before`, a comment's `id`, reads the comments posted before it. See [Comments, inbox and following](#comments-inbox-and-following) |
| `add_comment` | Comment on a task **as yourself** (the credential's user is the pinned author); markdown body of at most 20,000 characters; returns the comment `id`, task reference as `task`, and `created_at`; leaves no activity row, because the comment is its own feed entry |
| `create_task` | New task in a sub-project you can write to; `project` names it directly, or names a meta with `sub_project` naming one of ITS subs. Another project's sub-project is a hard error; move a task later with `update_task`. `parent` (a task ref) makes it a subtask; you need Edit access on the parent's project, because the parent becomes a group, and the parent must be in the same top-level project, in any of its sub-projects. `start_week` and `end_week` plan it (week starts, both or neither), and `paused` holds it. Optional `reporter_id` is a user returned by `list_project_users`; omission defaults it to the credential's user. `null` is refused, and the reporter cannot be changed after creation. Optional `reviewer_id` follows the `assignee_id` rule. Created straight into `review`, the task gets its project's review time as `remaining_hours` unless the call sends hours. `title` holds at most 255 characters and `description` 20,000 (see [Limits](#limits)). Returns `id` and `key` |
| `update_task` | Patch title/description/status/priority/assignee/reviewer/due date/plan weeks/remaining hours/paused (`paused: true` holds work; only a To Do, In Progress or In Review task without subtasks can be paused, and a move to Done or Backlog resumes it), plus `archived: true/false` to archive/restore (archiving carries the subtasks along; restoring surfaces the parent chain, and a subtask whose parent already has 100 active subtasks comes back without it) and `archive_reason`, posted as your comment when the call archives the task. It also moves the task (`project`, `sub_project`; to another top-level project its subtasks move along, and a subtask must leave its parent in the same call), sets or clears its parent (`parent`, `null` detaches) and adds or removes labels (`add_labels`, `remove_labels`, label ids or names). See [Moving, parents and labels](#moving-parents-and-labels). Both need User access on every project they change, so a subtask or parent the credential cannot edit refuses the toggle with `archiving this task would change a subtask in a project you cannot edit; an organization admin can archive it` or `restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it`. A subtask or parent in a project being moved to Deleted items refuses the toggle for everyone, admins included, with `a subtask of this task is being moved to Deleted items; try again when that finishes` or `a parent of this task is being moved to Deleted items; try again when that finishes`. The reporter is immutable: any `reporter_id` argument, including `null` or the current reporter, is refused before any other field is changed. `title` holds at most 255 characters, `description` 20,000 and `archive_reason` 500 (see [Limits](#limits)). The result's `updated` lists the fields you sent (`parent_id` for `parent`, `project_id` for a move, `labels` for label changes, and `archived_at` for a toggle), never a value the server set on its own, such as the review time. `expected` holds what you last read of the fields the call changes, keyed as `get_task` reads them, with `parent_id` and `has_hidden_parent` for `parent` and `project_id` for a move. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `delete_task` | Move a task to Deleted items with its comments, attachments, links, labels and follows; its subtasks become top-level tasks, the active ones at once and the archived ones a moment later, and their followers hear of it moments later; its inbox messages are deleted. A person can restore it in the app for 30 days, and no tool restores. Answers `{deleted: true, key}` |
| `set_task_link` | Add (`linked: true`) or remove (`linked: false`) the link between `ref` and `other`, with `kind` `blocks`, `blocked_by` or `relates` as seen from `ref`. Two tasks share at most one link. It needs read access to both tasks and Edit access on either, the app's rule. Adding the link that exists, or removing one that does not, changes nothing; `changed` in the result says whether the call did. A different link between the same tasks is refused with `these tasks are already linked`. A task is an end of at most 100 links, and a new link to a full task is refused naming it, such as `QN-9 already has 100 links, the most a task can have. Remove one of its links first.`. `get_task` lists the links |
| `list_labels` | The organization's labels as `id`, `name` and `color`, ordered by name |
| `set_label` | Without `label`, create a label from `name` (at most 40 characters) and `color` (`#` and six hex digits); this needs an organization admin, or a user (person or agent) with the User role and Edit access to a top-level project. With `label` (an id or name), rename or recolor that label; only organization admins may, as on the app's Labels settings page, and `expected` holds the `name` and `color` you last read of the fields it changes. Returns the label with `created`. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `delete_attachment` | Delete a file attached to the task `ref`; `attachment` is an id from `get_task`'s `attachments`. It needs Edit access to the task's project, as in the app, and leaves description images (`inline: true`) to the app. See [Attachments](#attachments) |
| `start_attachment_upload` | Start attaching a file to the task `ref`, given its `name` (1 to 255 characters), its exact `size` in bytes and an optional `content_type`. Answers `ticket`, an `upload_url` that stores one file and `expires_at`, an hour on. Send exactly `size` bytes to `upload_url`, then call `confirm_attachment_upload`. It needs Edit access to the task's project. See [Attachments](#attachments) |
| `confirm_attachment_upload` | Attach the file sent to `upload_url`, given the task `ref`, the `ticket` and the `storageId` the upload answered as `storage_id`. Answers the attachment as `get_task` lists it |
| `attach_text_file` | Attach text you write yourself, such as notes, a CSV table or a log, to the task `ref` as a file called `name`, with an optional `content_type` (`text/plain; charset=utf-8` by default). Qivo stores `text` as UTF-8, at most 256 KiB and within the organization's per-file limit. It needs Edit access to the task's project and answers the attachment as `get_task` lists it |
| `list_task_activity` | The task's newest history, at most 500 rows, oldest first, as the task window's Activity shows it: `id`, `created_at`, `actor_id`, `actor_name`, `verb` and `detail`. `before` (a row's `id`) reads the rows before it. See [Task activity](#task-activity) |
| `get_workload` | Each person's planned hours per week from the week holding `from_week` (default this week) for `weeks` weeks (1 to 52, default 8), optionally limited to one `project`. See [Workload](#workload) |
| `update_comment` | Replace a comment's `body` (at most 20,000 characters); `comment` is its `id` from `list_comments`. The comment's author may, and so may a lead of the task's project. `expected` holds the `body` you last read. See [Comments, inbox and following](#comments-inbox-and-following) and [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |
| `delete_comment` | Delete a comment, by the same rule as `update_comment`. `expected` holds the `body` you last read, because a deleted comment cannot be restored |
| `list_inbox` | Your inbox as `items`, one per active task you can read, latest activity first, with `unread_only`, `include_snoozed`, `limit` (50 by default, at most 200) and `offset`. `truncated` says some messages were not looked at |
| `update_inbox` | `read`, `unread`, `remove` or `snooze` your items about `tasks`, or with `all: true` mark every item read or remove every read item. `snooze` takes `until` |
| `set_following` | Follow a task (`following: true`) or stop following it |
| `update_user` | Set a user's `plannable_hours`. Allowed for an **organization admin**, or a **leader of a team that person belongs to**. Nobody else may, your own account included. An agent is never an organization admin (0100/0102) and never leads a team (only people do), so a leaked agent key cannot rewrite the organization's capacity plan. The database decides (0094), so a refusal here is the same refusal the app gives; the value is a **whole number of hours**, 1 to 168, and the schema turns a fraction away (0095). It applies to **people only**. An agent has no plannable week and cannot be given one (0103, "an agent has no plannable week, because its capacity is unbounded"), refused by the tool and by the RPC underneath. `expected` holds the `plannable_hours` you last read. See [Refusing a change when a field changed since you read it](#refusing-a-change-when-a-field-changed-since-you-read-it) |

### Refusing a change when a field changed since you read it

Two callers can read the same task and both change it, and the second call
then overwrites the first without either of them knowing. To prevent that,
`update_task`, `update_comment`, `delete_comment`, `update_project`,
`set_project_access`, `set_milestone`, `delete_milestone`, `set_label`,
`set_team` and `update_user` take an optional `expected` argument, an object with the value you last read of each field the call
changes. Qivo saves the change only when nobody else changed those fields
since. A call without `expected` saves as before. The rule, for each key:

- The key names a field the same call changes, and its value is the field as
  you last read it, `null` for unset.
- Qivo refuses the call when the stored value differs from the value you read
  and also from the value the call would store. Two callers who choose the
  same value both pass, and so does a field someone changed and changed back.
- A field without a key is not checked, so someone else's change to another
  field never refuses yours.
- If any field conflicts, the call saves nothing, its other fields, moves,
  labels and archive toggle included.

| Tool | Keys of `expected` |
|---|---|
| `update_task` | `title`, `description`, `status`, `priority`, `assignee_id`, `reviewer_id`, `start_week`, `end_week`, `due_date`, `remaining_hours`, `paused`, `parent_id` with `has_hidden_parent`, `project_id` |
| `update_comment`, `delete_comment` | `body` |
| `update_project` | `name`, `description`, `track_delay`, `review_hours`, `lead_id` |
| `set_project_access` with a `level` other than `null` | `level` |
| `set_milestone` with `milestone`, `delete_milestone` | `name`, `date` |
| `set_label` with `label` | `name`, `color` |
| `set_team` with `team_id` | `name` |
| `update_user` | `plannable_hours` |

Each key belongs to the argument of the same name, with three exceptions on
a task. `parent_id` and `has_hidden_parent` belong to `parent`, and
`project_id` to `project` or `sub_project`. A delete takes any of its keys.
`archived`, `archive_reason`, `add_labels` and `remove_labels` take no key
and are never checked. A call that creates a record takes no `expected`.
A call that creates a task, comment, project, milestone, label or team
refuses it with the sentence below.

Send each value as a read tool answered it:

- `get_task` gives a task's fields. Send `parent_id` and `has_hidden_parent`
  together, as the parent's uuid with `false`, `null` with `true` for a
  parent you cannot read, or `null` with `false` for no parent. A parent you
  read as hidden matches any parent you cannot read, so a move from one hidden parent
  to another is not detected, because telling you would reveal tasks you
  cannot see. An active task with subtasks reads `remaining_hours: null`,
  also while it stores hours of its own, so send `null`.
- `get_project` gives a project's fields, its milestones' `name` and `date`
  and its `grants`. `lead_id` is the lead it shows, so a sub-project without
  a lead of its own compares its parent's lead. A grant's `level` is `null`
  when `grants` lists no grant of that user or team.
- `list_labels` gives a label's `color` as clients paint it, so a label
  stored before the `#rrggbb` rule compares as `#8A8F98`.
- `list_comments`, `list_teams` and `list_users` give a comment's `body`, a
  team's `name` and a person's `plannable_hours`.

A value also follows the rule of its field. `start_week`, `end_week` and
`due_date` are real calendar dates written `YYYY-MM-DD`. `remaining_hours`
is from 0 to 99999.9, `review_hours` from 0 to 999, `plannable_hours` a
whole number from 1 to 168, and a label's `color` is `#` followed by six hex
digits. A task's `title`, a name and a comment's `body` are not blank once
trimmed, and a text has its field's limit from [Limits](#limits), counted
the same way: a `title` at most 255 characters, a team's, project's or
milestone's `name` at most 80, a label's `name` at most 40, and a comment's
`body` and a task's or project's `description` their fields' limits. The
schema of `expected` in the tool list carries the date shape, the hour
ranges, the color pattern, the text lengths and the `uuid` format of the
id keys, and Qivo also checks that a task date exists and that text is not
blank. Every read answers values that follow these rules.

A milestone's `date` is checked for the `YYYY-MM-DD` shape only, because a
milestone saved until 2026-10-16 can hold a day that does not exist, such
as `2026-02-31`, and a stale read of it must compare.

An id key is checked for its shape only. A well-formed uuid that names no
person, task or project is compared like any other value and can answer as
a changed field. Qivo does not check that it exists, because a refusal that
did would tell you which ids exist.

Values compare in a normalized form, so formatting alone never refuses a
call. Titles, names and comment bodies are trimmed, a task's or project's
description treats `""` as `null`, `remaining_hours` and `review_hours` are
rounded to 0.1, and ids and label colors compare in any case.

A malformed `expected` is refused before anything is saved or compared,
with the sentences [REST](rest-api.md#refusing-a-change-when-a-field-changed-since-you-read-it)
gives, such as `expected must be an object of the fields as you last read
them` (also for `null`), `expected must name at least one field`, `unknown
field "expected.colour"; expected takes name, color`,
`expected.remaining_hours must be a number from 0 to 99,999.9, or null`,
`expected.due_date must be a calendar date as YYYY-MM-DD or null`,
`expected.title must be a string that is not blank, of at most 255
characters`, `expected.name must be a string that is not blank, of at most
40 characters` (a label's), `expected.assignee_id must be a profile uuid or
null`, `expected.date must be a date as YYYY-MM-DD`,
`expected.parent_id applies only when the request sends parent` and
`expected.parent_id and expected.has_hidden_parent go together`. `expected`
on a call that creates is refused with `expected applies only when changing
an existing <record>`: `task` for `create_task`, `comment` for
`add_comment`, `project` for `create_project`, and `label`, `team` and
`milestone` for `set_label`, `set_team` and `set_milestone` without the
record. It is this sentence, not `Unrecognized key`, although the schemas of
`create_task`, `add_comment` and `create_project` have no `expected`.
On `set_project_access` with `level: null` it is refused with `expected
applies only when level is not null`.

A conflict answers one sentence as the tool's error result. It names the
fields by their argument, never their values, and names a person only where
Qivo can prove who wrote the stored value, from the task's history you may
read or, for a comment, its last editor:

```
<Name> changed <fields> of <record> since you read it, so nothing was saved; read <record> again and resend your change
<fields> of <record> changed since you read it, so nothing was saved; read <record> again and resend your change
```

For example, `Aisha Rahman changed status of QN-12 since you read it, so
nothing was saved; read QN-12 again and resend your change`. `it` becomes
`them` for several fields, and `<record>` reads as REST describes. A refused
delete ends `so nothing was deleted; read <record> again before you delete
it` instead of `so nothing was saved; read <record> again and resend your
change`. Never make the same call
again unchanged. Read the record, look at the other change, decide whether yours
still applies, and send it with the new values in `expected`.

### Stays in the app

These actions have no REST route or MCP tool. A person does them in the app
at https://qivo.io/app.

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

### Who am I

`get_me` takes no arguments and answers four objects:

```json
{
  "user": {
    "id": "…uuid…", "name": "Priya Patel", "org_role": "user", "kind": "person",
    "active": true, "plannable_hours": 31, "email": "priya@example.com"
  },
  "organization": {
    "id": "…uuid…", "name": "Northstar Labs", "slug": "northstar-labs",
    "date_format": "YYYY-MM-DD", "week_start": 1, "week_one_rule": "first4day",
    "default_plannable_hours": 32, "max_attachment_mb": 20,
    "project_creators": "users", "can_create_projects": true
  },
  "billing": { "read_only": false, "reason": null },
  "credential": {
    "kind": "personal_token", "access": "write",
    "expires_at": null, "name": "Laptop"
  }
}
```

- `organization.week_start` is the **Workdays start on** setting, `0`
  (Sunday) through `6` (Saturday), the first day of every planning week.
  `week_one_rule` is **Week 1 of the year** (`first4day`, `jan1` or
  `firstfull`), and `date_format` is how the app displays dates; tools always
  use `YYYY-MM-DD`. `default_plannable_hours` is the capacity a new person
  starts with, `max_attachment_mb` the upload limit per file in MiB, and
  `slug` the organization's part of app links.
- `project_creators` is the **Who can create new projects?** setting
  (`admins`, `users`, the default, or `selected`). `can_create_projects` says
  whether this user may create a top-level project under it, by the same
  rule as the app's **New project** button. A Standard user agent counts as
  a standard user, and a Viewer agent never may.
- `billing.read_only` is `true` while organization billing pauses editing,
  and while the organization is read-only before its deletion. `reason` is
  then the sentence writing tools are refused with, which names the deletion
  date in the second case. An organization admin can still remove access
  ([Request limits and billing](#request-limits-and-billing)). No plan, price
  or usage is included.
- `credential.kind` is `personal_token`, `oauth` or `agent_key`. `access` is
  `write` when the credential may make changes and `read` when it can only
  read, from the same rule that refuses writing tools (see
  **Read-only credentials** above). A change still needs the user's project
  permission and an organization that billing does not pause. `name` is the
  token's or key's name, or the connected app's name for OAuth. `expires_at`
  is the instant a personal token stops working, and `null` for a token
  without an expiry, an OAuth connection or an agent key.

The answer never contains a secret, a hash or a display prefix. A read-only
OAuth connection may call `get_me`, because it only reads.

### Projects, access and milestones

A `list_projects` row:

```json
{
  "id": "…uuid…", "key": "ENC", "num": 2, "name": "Enclosure", "type": "project",
  "parent_id": "…uuid…", "team_id": null, "description": "",
  "archived": false, "archived_at": null,
  "access": { "read": true, "write": false }
}
```

- `access` is what you hold on the project, by the same rule as REST's
  project rows. `read` is `true` on every row these tools return. `write` is
  `true` when you may create, edit and delete tasks in the project and
  comment on them. It needs Edit (`user`) or Lead access there and a
  credential that can make changes, so a read-only credential and a Viewer
  get `false` on every project. Changing the project's settings or its
  access needs Lead access, which `access` does not show.
- `write` does not look at archiving or billing, so an archived project
  still takes no new tasks and a billing pause still refuses changes.
- `archived` is `true` when `archived_at` is set, the instant the project
  was put away.

`get_project` answers the `list_projects` row with these fields added:

```json
{
  "lead_id": "…uuid…", "lead_name": "Leo Martins",
  "review_hours": null, "effective_review_hours": 2, "track_delay": true,
  "completion": { "done": 12, "total": 30, "percent": 40 },
  "milestones": [{ "id": "…uuid…", "name": "Prototype validated", "date": "2026-11-02" }],
  "grants": {
    "users": [{ "id": "…uuid…", "name": "Emil Strand", "level": "user" }],
    "teams": [{ "id": "…uuid…", "name": "Hardware", "level": "viewer" }]
  }
}
```

A sub-project without a lead of its own is led by its parent's lead.
`review_hours` is the project's own review time, and `effective_review_hours`
the time a task entering `review` gets. `completion` is the project's
**Completion** on the app's Overview. It counts the active tasks without
subtasks in the project, or for a top-level project in its sub-projects you
can read that are not archived, and `done` counts those that are Done. A
task whose only subtasks are hidden from you still counts as a group and is
left out, as in the app. `percent` is rounded, and `0` when `total` is `0`.
It is `null` for an archived project, and `create_project` answers zeros,
because a new project holds no tasks. `milestones` belong to the top-level
project, so a sub-project shows its parent's, ordered by date. `grants` are
the project's own individual and team grants, as its **Project access** list
shows them; a sub-project also inherits its parent's. A project you cannot
read answers `project "<ref>" not found (or not visible to you)`, exactly
like an unknown one.

**Names.** Project and milestone names are trimmed, may not be blank and hold
at most 80 characters, counted as in [Limits](#limits), so most emoji count
as two. A longer one is refused with `a project name must be at most 80
characters. Shorten it.` or `a milestone name must be at most 80
characters. Shorten it.`

**Creating.** `create_project` without `parent` makes a top-level project,
which follows the organization's **Who can create new projects?** setting
(`get_me` reports it as `can_create_projects`). A Standard user agent counts
as a standard user for it, including the **Can create projects** box under
`selected`, and a Viewer agent never creates projects. With `parent` it makes
a sub-project, which needs Lead access on that parent; a parent you cannot
read answers `parent project "<ref>" not found (or not visible to you)`. Qivo
picks the number, the key (from the name) and the position. `lead_id`
defaults to you, and only a person may name someone else. An agent always
leads what it creates, and naming another lead gets `only people can change
who has access, not agents`. An agent that leads projects cannot be made a
Viewer until an organization admin hands them over, so setting it to
Inactive is the way to stop it at once. A creator who is not an
organization admin and names someone else as lead of a top-level project
gets User access to it, as in the app. The tool takes no grants; add them
with `set_project_access`.

**Changing.** `update_project` needs Lead access (`requires lead access to
this project`). A lead handover alone on a top-level project follows the rule
for managing its users instead, so someone who is neither an organization
admin nor its lead gets `no permission to manage users on this project`. In
one call it restores (`archived: false`) or archives (`archived: true`) first,
then applies the fields and the lead, so a lead can archive a project and hand
it over together. Archiving a top-level project carries its active
sub-projects, and restoring brings back the ones archived with it. A lead
handover keeps the outgoing lead as User and drops the new lead's own grant,
and only a person may make one. A project takes no archive reason, as in the
app, where only archiving a task asks for one. `update_project` does not know
`archive_reason`, so a call that sends it is refused and changes nothing.

**Access.** `set_project_access` names exactly one of `user_id` and
`team_id` (uuids from `list_users` and `list_teams`). It needs a person who is
an organization admin or the project's lead (`no permission to manage users
on this project` otherwise; `only people can change who has access, not
agents` for an agent). A Viewer only receives `viewer`, and the lead's access
is the lead role (`that user leads this project; hand the lead to someone
else first`). With a level the result is `{project, user | team, level,
changed}`.

With `level: null` it removes the grant. Open tasks of the project and its
sub-projects that someone works on (as assignee, or reviewer of a task
without subtasks) and can no longer see afterwards are settled by
`on_held_tasks`:

- `"leave"`, the default, removes the access and lists them as `stranded`;
- `"keep_as_viewer"` gives those people a Viewer grant on the project, which
  is refused for a person whose removed grant was already Viewer;
- `{"reassign_to": "<user uuid>"}` hands each one over in the same role, and
  `{"reassign_to": null}` unassigns them; the new holder must be able to work
  on each task once the access is gone.

The removal and its choice land together or not at all. One removal reassigns
at most 120 tasks, and fewer when the change is too large for one call. Their
followers' inbox messages arrive moments after the removal. A larger handover,
or Viewer grants too many for one call, is refused and nothing changes. A
team's removal that keeps people as Viewers or reassigns their tasks is
refused the same way when more than 700 of its members hold open tasks in
those projects, with `a removal that keeps people as Viewers or reassigns their tasks can take
access from at most 700 people with open tasks at once. Leave the tasks
with them, or remove some of the team's members first.` Leaving the tasks has no such number.
Any removal whose people and tasks are too many to check in one call is
refused with `a removal can check only as many people and tasks as fit in one request, so
remove fewer people at once, such as some of a team's members, or reassign
some of the tasks first`. The
result adds `stranded`,
`kept_as_viewer` and `reassigned`; `stranded` and `reassigned` list `{id, key,
title, user_id, role}`. `changed` is `false` when there was no grant to
remove. `on_held_tasks` with a level is refused, and so is a misspelled
`on_held_tasks`, like any argument the schema does not know.

**Milestones.** `set_milestone` without `milestone` adds one from `name` and
`date` (`YYYY-MM-DD`, a real calendar day) to the top-level project of
`project`; with `milestone` (an id from `get_project`) it renames or moves it.
`delete_milestone` removes one. A milestone that is not on the top-level
project of `project` answers `milestone "<id>" not found (or not visible to
you)`. Both need Edit access on the top-level project, and an archived
project takes no new milestone. Results are `{id, name, date, project_id,
created}` and `{deleted: true, id}`.

Creating, renaming, archiving and restoring a project, handing over its lead,
changing its access and changing its milestones write the app's activity
rows, signed `via MCP`. A `set_milestone` call that changes neither a
milestone's name nor its date writes none. Changes to the description, review time or delay
tracking write none, as in the app. A call that renames a project and hands
over its lead writes only `renamed`.

### Teams

`list_teams` answers every team of your organization, by name, as
`{id, name, members}`. Everyone in the organization reads every team and its
members, as in the app. `members` lists `{id, name, leader}` by name, where
`leader` is `true` for a person who leads the team. Only people with the
organization admin or Standard user role lead teams, so an agent or a Viewer
never reads `true`. A guest is never a member, so an old membership a guest
still holds is not listed. Teams are named by `team_id`, a uuid from
`list_teams`, because two teams may share a name. One outside your
organization answers `team "<id>" not found in your organization`.

**Creating and renaming.** `set_team` without `team_id` creates a team from
`name`, which only an organization admin may do (`only organization admins
can create teams`). With `team_id` it renames that team, which an
organization admin or a leader of the team may do (`requires an organization
admin or a leader of this team` otherwise). `name` is trimmed, may not be
blank and holds at most 80 characters. The result is the `list_teams` row
plus `created`. Neither writes an activity row, as in the app. Deleting a
team stays in the app ([Stays in the app](#stays-in-the-app)).

**Members and leaders.** `set_team_member` changes one `user_id` in a team.
Members decide who sees the projects shared with the team, so it needs a
person who is an organization admin or a leader of the team; an agent gets
`only people can change who has access, not agents`, whatever its role.

- `member: true` adds the user as a plain member when they are not one yet,
  and `leader: true` or `false` makes or unmakes them a leader. A guest is
  never a member, and making an agent or a Viewer a leader is refused (`an
  agent cannot lead a team`, `a viewer is never a team leader`), in which
  case nobody is added. The result is `{team, user, member: true, leader,
  changed}`, with `team` and `user` as `{id, name}`.
- `member: false` removes the user, leadership included. Their open tasks in
  the projects the team shares, and in those projects' sub-projects, that
  they can no longer see afterwards are settled by `on_held_tasks`, as for
  `set_project_access`. `"leave"` (the default) lists them as `stranded`,
  `"keep_as_viewer"` gives the user a Viewer grant on the project the team
  shared that showed each task (the task's own sub-project when the team
  shares it, else its top-level project), and `{"reassign_to": user id or
  null}` hands them over. Keeping someone as a Viewer needs the right to
  manage that project's users, so a team leader without it is refused with
  `no permission to manage users on this project` and can still leave the
  tasks. The removal and its choice land together or not at all. One removal
  reassigns at most 120 tasks, and fewer when the change is too large for one
  call. Their followers' inbox messages arrive moments after the removal. A
  larger handover, or Viewer grants too many for one call, is refused and
  nothing changes. The result is `{team,
  user, member: false, leader: false, changed}` plus `stranded`,
  `kept_as_viewer` and `reassigned`; `changed` is `false` when the user was
  not a member.

`leader` with `member: false`, and `on_held_tasks` with `member: true`, are
refused. Every membership change writes the app's activity row, signed `via
MCP`.

### Task results

`list_tasks` rows and `get_task` share these fields besides the task's own
columns: `owner_id` (whose work it is, the reviewer while the task is in
`review` with one, else the assignee, and always the assignee on a group),
`parent_id` with `has_hidden_parent`, `start_week` and `end_week`, and `url`,
the address the app's **Copy link** gives. `parent_id` is the parent's uuid
when you can read the parent. Otherwise it is `null` and `has_hidden_parent`
is `true`, so a subtask under a task hidden from you is not mistaken for a
top-level task. A group's `start_week` and `end_week` come from the subtasks
you can read, at any depth.

`progress` is `null` for a task without subtasks. For a group it is the
**Progress** of the app's task window, `done` of `total` tasks without
subtasks under it, at any depth, that you can read, for example `{"done": 2,
"total": 3, "percent": 67, "partial": true}`. It counts the same subtasks
as the group's dates, scheduled or not, and `done` counts those that are
Done. `percent` is rounded, and `0` when `total` is `0`. `partial` is `true`
when some of the group is hidden from you, such as a subtask you cannot read,
so the true completion is unknown. The app then says "Completion unknown".

`delay` is the app's projected delay, the verdict its Roadmap and task
window show, for example `{"status": "behind", "projected_end_week":
"2026-10-26"}`. `status` is `ok`, `behind` or `late`, the app's **On
track**, **Currently delayed** and **Delayed**. `projected_end_week` is the
first day of the week the work is projected to finish. It is `null` when
`late` rests only on a passed due date, and for a finish after the year
9999. `delay` itself is `null` when the task's project does not track delay
(`track_delay` in `get_project`), when the task or its project is archived,
and when the app shows no verdict, such as for a Done task or one with
neither a plan nor a due date. The projection uses the owner's plannable
hours and their other scheduled work, counted as the app counts it for you.
For organization admins and users that includes work in projects they
cannot read, without naming it. For viewers and guests it includes only
work they can read or own, so two users can get different verdicts for one
task. A group with subtasks you cannot read can only be `late`, as in the
app. The server judges today's date in UTC, so near midnight or a week
boundary it can differ from the app, which uses the browser's time zone.

`last_comment_at` is when the newest comment on the task was posted, or
`null` when it has none. Editing a comment does not change it, and deleting
the newest one makes the one before it the newest.

`get_task` adds eight fields, which name only tasks you can read:

```json
{
  "group_remaining_hours": 6.5,
  "labels": [{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }],
  "subtasks": [{ "id": "…uuid…", "key": "QN-4", "title": "…", "status": "todo" }],
  "has_more_subtasks": false,
  "links": [{ "kind": "blocks", "id": "…uuid…", "key": "QN-9", "title": "…", "status": "backlog" }],
  "following": false,
  "followers": [{ "id": "…uuid…", "name": "Priya Patel" }],
  "attachments": [{ "id": "…uuid…", "name": "wiring.pdf", "size_bytes": 48213, "…": "…" }]
}
```

`following` says whether you follow the task, and `followers` lists everyone
who does, by name, as the app's follower list shows them. `attachments`
lists the task's files, described under [Attachments](#attachments).

`subtasks` are the direct subtasks you can read, by number. An active task
lists its active ones, also those in an archived project, which do not make
it a group while its own project is active, and an archived task lists all
of them. `links` are the
task's links whose other task you can read, `kind` as seen from this task.
`group_remaining_hours` is `null` for a task without subtasks. For a group it
is the remaining time the app shows, which is the sum over its unfinished
subtasks at any depth that you can read, or `null` when none has hours. Like
the group's dates, it counts only active subtasks of an active group, leaves
out subtasks in archived projects while the group's project is active, and
stops at a subtask you cannot read.

An archived group can have more tasks under it than one request can read,
such as thousands of subtasks or hundreds with very long descriptions.
`get_task` then still lists its direct `subtasks`, but `start_week` and
`end_week` are `null`, `progress` is `0` of `0` with `partial: true` and
`group_remaining_hours` is `null`. When even its direct subtasks do not all
fit, `subtasks` lists those of the first ones that do which you can read,
and `has_more_subtasks` is `true`. Find the rest with `list_tasks` and
`archived: true` for the group's top-level project, which covers its
sub-projects, where each one's `parent_id` names the group.
`has_more_subtasks` is `false` on every other task.

`list_tasks` returns active tasks as an array, oldest first by creation,
with tasks created at the same moment ordered by number, so `offset` pages
through them until a page holds fewer tasks than `limit`. `limit` is 50 by
default, and one that is not a whole number from 1 to 200 is refused with
`limit must be a whole number of tasks from 1 to 200.`, as on REST. A
`search` holds at most 200 characters, on active and archived lists alike,
and a longer one is refused with `a search must be at most 200 characters.
Search for fewer words.` Each row's
`last_comment_at` reads the task's newest comment, and a row whose parent is
in an archived project reads that parent. When those reads do not fit in
one request beside the rest of the page, the call is refused
with `this page of tasks is too large to read at once; ask for a smaller
limit`; call again with a smaller `limit`. A list also reads every active
task in the organization's active projects, or every active task of the
organization when it names an archived project or the organization has more
than 1,000 active projects. When those alone leave no
room for a single comment, the call is refused with `this organization's active tasks are too large to list in one request; archive done tasks and finished projects so fewer stay active`, and a smaller `limit`
does not help. When the call instead runs out of index reads, which follow
the active projects, your team memberships and the labels a search matches,
it is refused with `this organization has too many projects, teams or labels to list its tasks in one request; archive finished projects or search with fewer words`. A `search` whose label names it would have
to read for too many tasks at once is refused with `this search reads too
many label assignments to answer in one request; name a project or add a
filter`.

With `archived: true` it lists archived tasks one project at a time and
needs `project`. Naming a project lists its archived tasks and those of all
its sub-projects you can read, archived sub-projects included. The app's
Archived tasks page leaves out a sub-project archived on its own. Tasks come
most recently archived first, and tasks archived at the same moment keep one
fixed order across pages. The answer is an object, cursor first, with the
same rows as an active list:

```json
{
  "next_cursor": "2~9c41e07a…",
  "tasks": [{ "id": "…uuid…", "key": "QN-3", "archived_at": "…", "…": "…" }]
}
```

Pass `next_cursor` unchanged as `cursor` for the next page and stop when it is
`null`. The cursor is encrypted and has no readable parts. Older cursors that
start with `1~` are refused, so start again from the first page. A page can
hold fewer than `limit` tasks, or none, while `next_cursor` is set, because
each page reads a bounded amount however large the archive is. Tasks archived
after you start paging appear at the start of the list, so start again to see
them. If an archived group has more tasks under it than one request can read,
such as thousands of subtasks or hundreds with very long descriptions, its row
has `start_week` and `end_week` set to `null` and a `progress` of `0` of `0`
with `partial: true`, so paging still moves past it.

To find every archived task you can read, take two steps. First call
`list_projects`, once without arguments and once with `archived: true`.
Archived tasks can sit in active projects as well as archived ones, and both
lists include sub-projects. Then page `list_tasks` with `archived: true` for
each top-level project, the rows whose `parent_id` is `null`. Each covers all
its sub-projects you can read, even when you can read only some of them. To
read one sub-project's archive alone, name that sub-project.

These calls are refused: `archived: true` without `project` (`archived:
true needs project, because archived tasks are listed one project at a
time`), `cursor` without `archived: true` (`cursor works only with archived:
true`), an `offset` other than `0` with `archived: true` (`offset does not
apply to archived tasks; pass next_cursor as cursor`) and a `cursor` that is
not a `next_cursor` (`cursor must be the next_cursor of an earlier page`).

### Moving, parents and labels

`update_task` moves a task with `project` and `sub_project`, named as in
`create_task`; `sub_project` without `project` is refused. The move follows
the app's Move dialog. You need Edit access on the current and the
destination sub-project; a destination you can read but not write is
refused with `your account has no write access to that project`, and one you
cannot read reads `project "<ref>" not found (or not visible to you)`. The
task's assignee, and the reviewer of a task without subtasks, must be able to
work in the destination, and everyone working on its active subtasks must be
able to see it. An `assignee_id` or `reviewer_id` in the same call, null
included, takes the place of the current one in this check, and a new one is
checked against the destination. A moved task keeps its key, labels, links
and subtasks.

A move within the task's top-level project moves only the task. A move to a
sub-project of another top-level project also moves every subtask,
archived ones included, that is not already in that top-level
project. You need Edit access on each of their projects (otherwise `moving
this task would move a subtask in a project you cannot edit; an organization
admin can move it`). A subtask in a project that is being moved to Deleted
items refuses the move for everyone, admins included, with `a subtask of
this task is being moved to Deleted items; try again when that finishes`.
The assignee and the reviewer of each active subtask must be able to work
in the destination (otherwise `someone assigned to or reviewing a subtask of
this task cannot edit that sub-project; give them Edit access there, or
change who works on that subtask first`); a group's own reviewer who cannot
is cleared. A task with more than 200 subtasks, archived ones included,
cannot move to another top-level project (otherwise `this task has more than
200 subtasks, archived ones included, and a move to another project carries
them all. Restore some archived subtasks and remove them from this task
first, or move it within its project.`). A move whose task and subtasks are
too large for one call, such as about 120 or more subtasks whose
descriptions hold 20,000 characters of a script that takes three bytes a
character, such as Japanese, is refused with `this task and its subtasks
are too large to move to another project in one request; remove some
subtasks from this task first, restoring archived ones to do so, or move
it within its project`. Any other change whose task and subtasks are too
large for one call, such as an archive, a new parent or a restore, is
refused with `this task and its subtasks are too large to change in one
request; detach some subtasks first`. Each moved subtask sends `task.updated`, but only the task
itself gets an activity row and an inbox message. A subtask moved to another
top-level project must leave its parent in the same call, with `parent:
null` or a new parent in the destination's top-level project; otherwise the
call is refused with `a subtask stays in its parent task's project; to move
it to another project, detach it from its parent in the same change`.

A task has one level of subtasks, at most 100 active ones; archived
subtasks do not count. `parent` is refused with `the parent task is a
subtask, and a subtask cannot have subtasks of its own` for a parent that is
a subtask, with `this task has subtasks, so it cannot become a subtask; a
subtask cannot have subtasks of its own` for a task with subtasks, and with
`the parent task already has 100 active subtasks, the most a task can have.
Archive or remove one of them first.` for a full parent. `parent: null`
always detaches. Restoring a subtask (`archived: false`) whose parent
already has 100 active subtasks brings it back as a top-level task: the
task you read back has no parent, and its followers are told it left its
parent. So does restoring a subtask whose parent was deleted after the
subtask was archived, even when the parent is back from Deleted items,
because that delete takes every such subtask off the parent. Naming that
parent as `parent` to keep it is refused with `this task's parent was
deleted after this task was archived, so the task comes back as a top-level
task; restore it without naming that parent`. A parent in a project you cannot see counts as being in the subtask's own
top-level project, so moving such a subtask to another top-level project
also needs `parent: null` or a new parent there.

`parent` (a task ref) makes the task a subtask of that task, and `null`
detaches it. You need Edit access on the parent's project, because the
parent becomes a group and loses its own remaining hours. A parent you
cannot read reads `parent task "<ref>" not found (or not visible to you)`.
A subtask stays in its parent's top-level project, in any of its
sub-projects, so a parent in another top-level project, after any move in
the same call, is refused with `a subtask must be in the same project as its
parent task, in any of its sub-projects`.
The task cannot become its own parent, an active task cannot go under an
archived parent, and a task has one level of subtasks (see above). Everyone assigned to or reviewing the task or its subtasks must be
able to see the new parent. An `assignee_id` or `reviewer_id` in the same
call, null included, counts in place of the current one.

`add_labels` and `remove_labels` take label ids or names in any case from
`list_labels`. Labels change one at a time, never as a replacement list, and
asking for a label the task already has, or removing one it lacks, changes
nothing. An unknown label, or one in both lists, is refused. A task carries
at most 20 labels. `remove_labels` applies before `add_labels`, so one call
can swap labels on a full task, and a label past 20 is refused with `this
task already has 20 labels, the most a task can have. Remove one first.`

One call may combine all of it. It applies the move, then the parent, then
the other fields with the archive toggle, then the labels, then
`archive_reason`. Everything lands or nothing does. Each step that changes
something writes its own activity row signed `via MCP`, and a call that
changes nothing writes none.

### Attachments

`get_task` lists every file of the task, oldest first, including the images
inside its description:

```json
{
  "id": "…uuid…", "name": "wiring.pdf", "size_bytes": 48213,
  "content_type": "application/pdf", "inline": false,
  "uploaded_by_id": "…uuid…", "uploaded_by_name": "Priya Patel",
  "created_at": "…",
  "url": "https://api.qivo.io/files/…?e=…&m=…&t=…",
  "url_expires_at": "…"
}
```

`inline` is `true` for a description image, which the description names as
`![alt](att:<id>)`. `url` downloads the file for 10 minutes
(`url_expires_at`); call `get_task` again for a fresh link. Each download
checks again that your user is active and can see the task's project, but
not the credential, so a link fetched before a token was revoked works until
it expires. Images open in the browser and other types download.

`delete_attachment` deletes one file and writes a `removed an attachment
from` activity row signed `via MCP`. Anyone with Edit access to the
project may delete any file, not only their own. An id that is not a file of
that task reads `attachment "<id>" not found on QN-<n>`. A description
image goes when the description stops showing it, so `delete_attachment`
refuses one with `this image belongs to the task description; remove it by
taking it out of the description`, and neither upload tool adds one.
When `update_task` rewrites a description, keep every `![alt](att:<id>)`
reference whose image should stay. A description save, from the app or a
tool, that takes out an image's last reference removes the image from the
task at once: it no longer counts toward the 100 attachments and no longer
appears in `attachments`. A save within a day that names it again brings it
back, unless the task has 100 attachments by then, which is refused with
the full-task sentence below. After a day the image is deleted, and a task
keeps at most the 100 most recently removed images, so the oldest goes at
once when a save removes more. An image that no saved description has named a day after its upload, such as one a
closed browser tab left, is removed by the task's next description save.

A description can only show images attached to its own task.
`create_task` or `update_task` with a description that adds a reference to
any other image, such as one copied from another task, or one deleted
since, is refused with `the description shows an image that is not
attached to this task, such as one from another task; remove it, or upload
the image to this task`.

Uploading a file takes three steps, the same as on REST:

1. `start_attachment_upload` with the task `ref`, the file's `name` (1 to
   255 characters after trimming), its exact `size` in bytes and optionally
   its `content_type`. It needs Edit access to the task's project. A task
   holds at most 100 attachments, images in its description included, so a
   full task is refused before any bytes are sent, with `this task already
   has 100 attachments, images in its description included, the most a task
   can have. Remove one first.`, and the confirm checks it again. A `size`
   over the organization's per-file limit (`max_attachment_mb` in `get_me`,
   at most 20 MiB) is refused with `a file must be at most 20 MiB, this
   organization's attachment limit. Attach a smaller file.` The 20 MiB
   ceiling is Qivo's product rule: attachments are for images, PDF files and
   similar documents, and Qivo is not a file store. It answers `{ "ticket": "…uuid…", "upload_url": "…",
   "expires_at": "…" }`.
2. `POST` the file's bytes, exactly `size` of them, to `upload_url`, with
   the file's type as `Content-Type` and no Authorization header, for example
   `curl -X POST -H "Content-Type: application/pdf" --data-binary @wiring.pdf "<upload_url>"`.
   It answers `{ "storageId": "…" }`.
3. `confirm_attachment_upload` with the `ref`, the `ticket` and that
   `storageId` as `storage_id`. It answers the attachment and writes an
   `attached a file to` activity row signed `via MCP`.

The file goes straight to storage, so it never passes through an MCP call or
the model's context, and the upload URL needs no credential. The ticket and
its upload URL expire after an hour. The upload URL stores one file. While
a `POST` is storing the file, and once it has, another `POST` answers `409`
with `this upload URL has already been used; start a new upload` and stores
nothing. A body of another size than declared answers `400` with `the upload
must be exactly the 48213 bytes declared` and stores nothing, after which
the URL can be tried again, unless, rarely, Qivo could not free it, when it
answers `409` for at most 15 minutes. A `POST` that conflicts with other
`POST`s sent to the same URL at that moment, or that a busy server kept from
finishing in time, answers `503` with `Retry-After: 1` and stores nothing,
so wait and send it again, or, rarely, `409` when Qivo could not free the
URL either. Qivo reads the body in one of
its own request handlers, which stays busy until the file has arrived, for
at most 5 minutes, so send large files a few at a time. A refusal such as
the `409` or the size `400` waits only 5 seconds more for the rest of the
body, so a large upload that is refused can end with the connection closed,
or with a `502` from the hosting front end, instead of the answer. Treat
either like a network error. Once the upload is confirmed,
its URL answers
`404` like an expired one (see [REST attachments](rest-api.md#attachments)
for every answer). Only the user that started
the upload can confirm it, only for the same task, and only once. A ticket
belongs to the user, not the credential, so a ticket started over MCP can be
confirmed over REST by the same user, and the reverse. The confirm follows
REST's rules. Another ticket, including an expired one, answers `upload not
found or expired; start a new upload`, and a `storage_id` that is not the
`storageId` the upload URL answered is refused with `storage_id must be the
storageId the upload answered`, or with `no file has been sent to this upload
URL; send it there, or start a new upload` before the upload URL has stored
one. If the organization lowered its per-file
limit after the upload started and the file now exceeds it, Qivo deletes the
file, refuses the confirm and spends the ticket. Bytes uploaded but never
confirmed are deleted by the weekly storage sweep.

Uploading needs a client that can send an HTTP request with the file, such
as a coding agent with a shell. Chat assistants that cannot make HTTP
requests cannot upload files, but they can still attach text they write
with `attach_text_file`. It takes the task `ref`, a file `name`, the `text`
and an optional `content_type` (`text/plain; charset=utf-8` by default) and
stores the text as a UTF-8 file in one call. The text may hold at most 256
KiB once encoded, and the organization's per-file limit and the 100
attachments per task apply too, both checked before the text is stored. Longer
text is refused with `text must be at most 256 KiB (262,144 bytes) as UTF-8.
Split it into several files.`
The request body limit of 1 MiB counts the text as JSON escapes it, so text
made mostly of control characters, which JSON writes as six bytes each, can
meet the body limit's `413` first.
A request that is not valid UTF-8 is refused before anything is stored, as
[Request limits and billing](#request-limits-and-billing) describes.
It needs Edit access to the task's project like the upload, answers the
attachment and writes the same activity row. A refused call keeps no
file.

### Task activity

`list_task_activity` answers the task's newest history, oldest first, the
rows the task window's **All** filter shows beside the comments
(`list_comments` has those):

```json
[
  {
    "id": "…uuid…", "created_at": "…",
    "actor_id": "…uuid…", "actor_name": "Leo Martins",
    "verb": "changed", "detail": "(status To Do → In Progress), via MCP"
  }
]
```

You receive the rows the task window's **All** filter shows you. Organization
admins receive every row. Other users do not receive a row that names a
project they cannot access, such as where the task was before a move, or
another task they cannot read, such as the other end of a link. An
archived task's history is answered too, by the same rule. `actor_id` and
`actor_name` are `null` once the user who made the change has been removed
from the organization. A task keeps all its activity rows, and an answer
holds at most 500 of them. To read further back, pass the `id` of the first
row as `before`, and repeat until the list is empty. Only an empty list means
there is no earlier history. A `before` that is not the `id` of a row in this
task's history is refused with `before must be the id of a row in this task's
history`. The call reads on past rows you do not receive, and when it cannot
find one you receive before it has read as much as one call may, it is
refused with `too many of this task's changes are hidden from you to read them
at once; an organization admin can read them`. Deleting a task for good from
Deleted items deletes its history.

### Workload

`get_workload` answers each person's planned hours per week, as the
Roadmap's Team strip and the planning panel count them:

```json
{
  "week_starts": ["2026-10-12", "2026-10-19"],
  "project": null,
  "people": [
    {
      "id": "…uuid…", "name": "Leo Martins", "org_role": "user", "kind": "person",
      "active": true, "plannable_hours": 32,
      "hours": [30, 22], "hidden_hours": [4, 0]
    }
  ]
}
```

- `from_week` is any day of the first week (`YYYY-MM-DD`), by default the
  current week. Weeks begin on the organization's `week_start` from
  `get_me`. `weeks` is 1 to 52, 8 by default. A window with a week that
  starts before 0000-01-01 or after 9999-12-31 is refused with `the workload
  window must fall within the years 0000 to 9999`.
- `project` (number, key or uuid) limits the hours to that project and its
  sub-projects; `project` names it in the result.
- `hours[i]` is the week starting `week_starts[i]`, rounded to a tenth. A
  task counts toward its owner (the reviewer while it is In Review with one,
  else the assignee) when it is scheduled, not Done, not paused, has
  remaining hours and is not archived. Its remaining hours spread evenly from
  the week of its `remaining_set_at`, or its start week if later, through its
  end week.
- Compare `hours` with `plannable_hours`. An agent's is `null`, because
  agents have no weekly limit.
- Organization admins and Standard users also receive the hours of projects
  they cannot see, in `hours` and `hidden_hours`, without naming the task or
  project. `hidden_hours` is the part of `hours` from those projects, so do
  not add the two. Viewers and guests receive only work they can see or own.
  With `project`, `hidden_hours` is all zeros.
- `people` lists every active user and agent, and any inactive one with hours
  in the window, ordered by name.

### Comments, inbox and following

`list_comments` answers a task's newest comments, oldest first in the order
they were posted. It holds at most `limit` comments (50 by default and at
most), and fewer when they are long, because one call reads at most about 8
MiB of comments. To read further back, pass the `id` of the first comment in
the result as `before`, and repeat until the result is an empty list. Only
an empty list means there are no earlier comments. A `limit` that is not a
whole number from 1 to 50 is refused with `limit must be a whole number of
comments from 1 to 50.`, and a `before` that is not the id of a comment on
this task with `before must be the id of a comment on this task`.

`update_comment` and `delete_comment` take the comment's `id` from
`list_comments`. As in the app, the comment's author may edit or delete it,
and so may a lead of the task's project (an organization admin leads every
project); anyone else is refused with `only the author or a project lead can
edit this comment` (or `delete`). A comment on a task you cannot read reads
`comment "<id>" not found (or not visible to you)`, like an unknown one. The
new body is trimmed and may not be blank. Sending the text the comment
already has changes nothing, and the result's `changed` says so. An edit
records `edited_at` and `edited_by_id`, and people it newly mentions follow
the task and get an inbox message. Neither tool writes an activity row or a
task event.

Comment bodies, like task descriptions, hold at most 20,000 characters,
counted as UTF-16 code units (JavaScript string length) after trimming, so
most emoji count as two, and the server refuses a longer one with `a comment
must be at most 20,000 characters. Formatting counts too. Shorten it.`, as
for REST and the app.

A task has no limit on the number of comments.
`set_following` follows a task (`following: true`) or stops following it.
Following needs only read access to the task, and the result's `changed`
is `false` when nothing changed. Followers receive the task's updates in
their inbox. Qivo also makes you follow a task when you are assigned or
handed it, mentioned on it or comment on it. You can change only your own
follow. A task has at most 100 followers. Following one that has 100 is
refused with `this task already has 100 followers, the most a task can
have. Someone must unfollow it first.`, and a comment or a mention there adds no follower, though the
mention still notifies. A new assignee or reviewer still becomes a follower.
A comment or description can mention at most 100 distinct people. A tool
call whose text mentions more is refused with `a text can mention at most
100 people. Remove some mentions and save again.` and saves nothing.

`list_inbox` answers your inbox as the app's **Inbox** shows it, one item per
task, latest activity first:

```json
{
  "items": [
    {
      "task": { "id": "…uuid…", "key": "QN-3", "title": "Fix hinge tolerance", "status": "progress" },
      "unread_count": 1,
      "dropped_count": 0,
      "latest_at": "2026-10-14T09:12:03.000Z",
      "snoozed_until": null,
      "messages": [
        {
          "id": "…uuid…", "kind": "comment", "detail": "New comment",
          "actor_id": "…uuid…", "actor_name": "Priya Patel",
          "created_at": "2026-10-14T09:12:03.000Z", "read_at": null
        }
      ]
    }
  ],
  "truncated": false
}
```

`task` is the task as it is now, its current title included. As in the app,
items are listed only for active tasks you can read in active projects.
Messages about a task you lost access to, an archived task or a task in an
archived project stay stored and come back when the access or the task does,
unless they were removed meanwhile. Archiving a task marks every message
about it and the subtasks archived with it read, for every recipient,
shortly after the archive, and archiving a project does the same for its
tasks. A snoozed item loses its snooze, and a snooze that ends before the
marking does not bring the item back unread. Messages that arrive while the
task or its project is archived, including the `Archived` message (the
nightly automatic archive sends none), mentions and comments, are stored
read. As with any read message, the nightly cleanup removes them after the
recipient's retention period, and `update_inbox` with `action: "remove"`
and `all: true` removes them too. A restore brings back the items still
stored, with their messages read. A restore that comes before the marking
leaves the messages as they were. Other followers of a restored task also
receive an unread `Restored` message, which replaces the item's read
messages as any new message does. Parents restored along with a subtask
send no `Restored` message. Deleting a task or a project deletes the
messages about its tasks, and restoring it from Deleted items does not
bring them back. `messages` run oldest first, `kind` is
`mention`, `comment` or `change`, and `detail` is the line the app shows.
`latest_at` is the newest message's time, or the end of a snooze when that
is later. Snoozed items are left out unless `include_snoozed` is `true`. An
item keeps at most 50 unread messages. When more arrive, Qivo drops the
oldest unread ones but keeps the item's first unread message and the newest
message of each `kind`. On a task with many followers it does so moments
after the arrival, so an item can briefly hold one more. The item's
`dropped_count` says how many it dropped, until the item is read, and the
app's **Inbox** shows it as **N earlier updates on this task are not
listed**. The task's comments and history still hold what those messages
announced. A comment or a
change on a task with more than 128 followers, such as a task from before
the follower limit, reaches the first 128 at once and the rest moments
later. The same holds when many of the people a write mentions or notifies
have snoozed a long thread about the task, because each message wakes
theirs. The followers of the tasks a roadmap save or an access removal
changes, and of the subtasks a task delete detaches, get their messages
moments after it saves.

One call lists up to 500 of your unread messages (newest first) and up to
500 read ones (most recently read first). It looks at no more than 1,000 of
each, counting the stored ones about tasks it does not list. When some
messages were not looked at, `truncated` is `true`, so a large backlog about
such tasks can set it too. Items whose messages were not looked at are then
missing, and an item listed may lack its older messages. The app's **Inbox**
loads up to 500 of the same messages, unread ones first. Marking items read
keeps only each item's latest message, so `update_inbox` with
`action: "read"` and `all: true`, repeated while `has_more` is `true`,
shrinks the inbox until it fits.

`update_inbox` applies `action` to your items about `tasks`, at most 100
task refs per call with repeats counted (a longer list is refused with
`tasks must name at most 100 tasks per call. Send the rest in another
call.`), or with `all: true` to every item:

- `read` marks the items read and, like opening an item in the app, keeps
  only each item's latest message. With `all`, it marks every item read
  except snoozed ones, and the result adds `before`, a number. Pass it back
  unchanged as `before` on each later call, so messages that arrive
  meanwhile stay unread. `before` with `tasks` or another action is
  refused.
- `unread` marks the items unread again.
- `remove` removes the items. With `all`, it removes every read message
  except snoozed ones and leaves unread messages alone.
- `snooze` hides the items until `until`, an ISO date-time in the future and
  at most 366 days ahead, and marks them unread, so they return bold.
  `until: null` brings snoozed items back now. A new update on the task
  brings its item back too.

The result is `{ "action": "read", "tasks": ["QN-3"], "has_more": false }`,
where `tasks` lists the items the call changed. With `all`, each call
changes up to 256 messages; repeat it while `has_more` is `true`. Like the
app's bulk actions, `all` also reaches messages about tasks that are not
listed, archived ones and those you can no longer read, but the result names
only tasks you can read. A task ref you cannot read refuses the whole call
with `task "<ref>" not found (or not visible to you)`. Naming neither or
both of `tasks` and `all`, `all` with `unread` or `snooze`, `until` on
another action and `snooze` without `until` are refused.

`unread` and `snooze`, with a date or `null`, refuse a task that is archived
or in an archived project. No inbox lists such a task, and its messages stay
read until it is restored. The refusal names the task:
`QN-3 is archived and must be restored first`,
`QN-3 is in an archived project, which must be restored first` or
`QN-3 and its project are archived and must be restored first`. One such
task refuses the whole call, even when you hold no messages about it, and
nothing changes. A task ref you cannot read is refused first, as above.
`read` and `remove` still work on archived tasks.

The nightly cleanup removes read messages after your retention period, which
a person sets in the app. An agent has no settings page, so its read
messages are removed after 7 days. Unread messages are never removed by it.

Only an active Standard user agent receives inbox messages. A Viewer agent
and an Inactive one cannot mark messages read or remove them, so Qivo sends
them no messages and does not make them followers, whether by a mention, a
comment, an assignment or a project lead. Messages they already hold stay. A
Viewer agent can still read them with `list_inbox`, and both receive new ones
again once the agent is an active Standard user.

### Import attribution

Task results from `list_tasks` and `get_task` expose Reporter
(`reporter_id`/`reporter_name`), Assignee (`assignee_id`/`assignee_name`) and
Reviewer (`reviewer_id`/`reviewer_name`).
The reporter is fixed at creation; task results contain no separate creator
fields. The activity trail still records the authenticated user who actually
performed each operation.

For an import, resolve the destination project first, call
`list_project_users` for that project, and map source identities only to IDs
returned by that tool. Then pass the mapped ID as `reporter_id` to
`create_task`. A source name, email address, or external-system user ID is
never accepted in a Qivo user field. Omit `reporter_id` to use the importing
credential's user when there is no suitable mapping; an explicit `null` is
refused. The same project-visibility rule applies to `assignee_id`, with the
additional requirement that its roster row says `assignable: true`: active
with effective Edit (`user`) or Lead access, including inherited team/parent
access and the organization Viewer ceiling. Existing assignments survive a
permission downgrade, a switched-off account and updates that omit
`assignee_id`. Sending the task's current `assignee_id` again is not a change
and passes even when that person is no longer eligible, as in the app. Any
other non-null `assignee_id` requires current eligibility.
`reviewer_id` follows the same rule: only a row with `assignable: true` may be
a reviewer, and `null` clears it. On a subtask, a new assignee or reviewer
must also be able to see every task above it, which `assignable` does not
check; otherwise the call is refused with `a subtask can only be assigned to
someone who can see every task above it` (or `… reviewed by …`). The refusal sentences are the assignee's,
except that the Edit-permission one ends `to review work`. A reviewer may be
the same user as the assignee.
The browser always uses its signed-in user as reporter and never offers a
reporter picker.

`update_task` does not accept `reporter_id`. Supplying it returns an
`isError: true` input-validation result containing
`reporter_id is set when a task is created and cannot be changed`; the entire
update is refused, including any other fields in that call.

Tasks with active subtasks are groups. `list_tasks` and `get_task` include
`is_group: true`; their stored `status` is dormant and must not be displayed
or counted as their own workflow status. Status filters exclude groups.
`update_task` with `status` on a group refuses with
`status cannot be set on a task with subtasks, so update its subtasks instead`.
For a task in an active project, only active subtasks in active projects
count. A subtask in an archived project, such as a sub-project archived on
its own, does not make it a group. A task in an archived project counts
every active subtask. Removing, detaching or archiving the last such
subtask, or archiving its project, restores the parent's saved status.
Restoring that project makes the parent a group again, and background steps
clear its own `remaining_hours` moments later, as attaching a subtask does.
They do the same for a task that is still a group when its own project is
restored after its subtasks' project. Archived parents retain `is_group: true` while they
have attached subtasks. This boolean also covers inaccessible children
without disclosing their identities. A group has no reviewer of its own:
setting a new non-null `reviewer_id` on one refuses with `a task with
subtasks has no reviewer of its own; set reviewers on its subtasks`, while
clearing one always passes.

While a task is in `review` with a reviewer set, it is the reviewer's task:
the app counts its remaining time against the reviewer's week and shows the
reviewer as its owner. In every other status the assignee owns it.

The hours field on tasks is `remaining_hours` — named `estimate_hours` until
2026-07-17 (0063; it now means hours of work *left*). The old name is no
longer in the `create_task`/`update_task` schemas. A client still sending
`estimate_hours` is refused with `Unrecognized key`, and the call changes
nothing. Update the client. A task **with
active subtasks** has no remaining time of its own (0066; archived
subtasks stopped counting in 0070, and subtasks in archived projects do not
count for a task in an active project). `update_task` with a non-null
`remaining_hours` for one is refused with `remaining_hours cannot be set on a
task with subtasks, because it is the sum of their remaining time`, also when you
cannot read the subtasks. `null` passes as a no-op. The hours live on the
subtasks, and the app shows the parent's value as the sum over its unfinished
subtasks; such tasks read back `remaining_hours: null` and
`remaining_set_at: null`, also while they still store hours of their own
from before their subtasks counted.

Tasks also read back `remaining_set_at` (0072) — the server-stamped moment
`remaining_hours` was last saved. A remaining time is a measurement, and the
app's planning math anchors on when it was taken. The stamp moves when the
value genuinely *changes* (re-sending the same number is a no-op there) and
when the task enters `review` (below), not when the task moves to another
sub-project. It clears together with the hours and cannot be written over
MCP. It is not in any tool schema, so a call
that sends it is refused like any unknown argument.

A task that enters `review`, created there or moved there, gets its project's
review time as `remaining_hours`. That is `effective_review_hours` in
`get_project`, 2 hours unless a lead sets another in the app or with
`update_project` (see [Projects, access and
milestones](#projects-access-and-milestones)). The task gets a fresh
`remaining_set_at` even when the hours are unchanged. A non-null
`remaining_hours` in the same call wins; `null` or no value takes the review
time. Leaving `review` keeps whatever is left, and a call that stays in
`review` changes nothing. `update_task` does not add `remaining_hours` to
`updated` for this; read the task back to see it.

Archived tasks (0070) are a separate axis from `status`: they leave the
default `list_tasks` result (`archived: true` with `project` pages them, see
[Task results](#task-results)), stop counting as workload, and in the app live
on the Archived tasks page. A nightly sweep archives tasks that have been `done`
for 30 days. Restoring a still-`done` task restarts its
auto-archive clock (0071), so a restore holds for the full threshold. A move
to another sub-project restarts it too, for the task and each subtask that
moves with it.
`create_task` rejects `archived` outright, because tasks are created
active. The schema declares the key so that the refusal names the fix,
rather than a bare unknown key.
In the app, archiving unfinished work requires a written reason, stored as a
comment. `update_task { archived: true }` does not require one, but
`archive_reason` in the same call posts it the same way, as your comment at
the moment of the archive. It is posted only when the call archives the
task, so not for a task that is already archived, and a blank reason posts
nothing. `archive_reason` without `archived: true` is refused. It is at most
500 characters after trimming, the same limit as the app's delete reason, and
a longer one is refused with `an archive reason must be at most 500
characters. Shorten it.` before the call changes anything, also for a task that is
already archived.

Archived **projects** (0106) are the same idea one altitude up, and a
separate axis again. A project that has been put away in the app keeps
everything it had, but it is not part of the working set: it is absent from
`list_projects` unless you pass `archived: true`, its tasks are absent from
`list_tasks` unless `project` names it, and `create_task` into one is
refused with a sentence naming the project to restore. Naming a LIVE project
asks for it as it stands, so a sub-project archived out of it stays out;
naming an archived one asks for it as it was put away, and everything under
it comes. A project lead archives or restores a project with `update_project`
(`archived: true` or `false`), as in the project's settings in the app, and
REST does the same with `PATCH /v1/projects/{ref}`.

Mentions (0074/0075/0114): description and comment markdown may carry the
app's mention form — `@[Display Name](user:<profile uuid>)` (uuids from
`list_users`; the label may not contain square brackets, and mention
syntax inside code spans or fenced blocks renders literally and does not
notify). A mention delivers an inbox message to that user, and any task
change or comment messages everyone **subscribed** to that task —
attributed to **you**, the credential's user, exactly like the same edit in
the app (never to yourself). Since 0114 that is the whole rule: subscribers,
not "the assignee", who is simply subscribed by having been assigned. Being
@mentioned or leaving a comment subscribes you as well, so commenting through
`add_comment` starts sending you that task's news. Whoever a task passes to
starts following it too: the reviewer when the task enters `review` with a
reviewer set (or a reviewer is set while it is there), who reads `Ready for
your review`, and the assignee when it leaves `review` again. A reviewer set
in any other status is not subscribed.

Following a task yourself is `set_following`, and you read and clear what
arrives with `list_inbox` and `update_inbox` (see [Comments, inbox and
following](#comments-inbox-and-following)). No tool reads or changes anybody
else's inbox or follows; theirs change only through the messages and
subscriptions described above. The server does the rest, inside the same
transaction as the write.
Unknown/out-of-org uuids, users without visibility into the project and
agents that receive no inbox messages (Viewer or Inactive agents) are
silently skipped, so a subscription never outlives the project access that
justified it.

Tool errors are readable sentences ("not found (or not visible to you)",
"your account has no write access to that project") — a denial by the access
layer looks like the object not existing, matching the app.

## Implementation notes

- Hand-rolled stateless JSON-RPC over one POST route — a Convex HTTP action
  (`convex/machine/mcp.ts`), no MCP SDK. The credential is resolved before
  dispatch; OAuth additionally rechecks the live grant and scopes before each
  tool, including every call in a batch. Every tool is one internal Convex
  function that takes the resolved user and the credential's access
  explicitly and re-asserts them, and a writing tool refuses a read-only
  credential first. `get_me` also takes the credential row that authenticated
  the request, and shares its read with REST's `GET /v1/me`. Ref resolution, the rules a write must satisfy, the write
  and its activity trail all run in one transaction. What the surface file itself holds is the MCP grammar: the
  two protocol legs, the header rules, tool names, schemas and transport.
  The verbs and the sentences a refusal is phrased in live in the shared
  model layer the REST API and the app run on too, so the surfaces cannot
  drift apart again.
- `convex/tests/mcp.test.ts` pins the tool catalogue and response bytes on both
  protocol legs by SHA-256 — changing a tool description is a deliberate act
  that fails a test, never drift.
- The bearer is an OAuth `qvo_` access token, a `qvt_` token or a `qva_` agent
  key; the HTTP action is the authenticator. A `401` carries
  `WWW-Authenticate: Bearer` with protected-resource metadata and
  `qivo:read qivo:write offline_access` scope guidance. Existing manual
  credentials keep three refusal sentences:
  `missing credential (Authorization: Bearer qvt_… or qva_…)`,
  `unknown, revoked or deactivated agent key` and
  `unknown, expired or revoked MCP token`. They deliberately do not disclose
  the credential's exact state.
- Any verb but POST and the CORS preflight answers `405` with `Allow: POST,
  OPTIONS` and the body `stateless MCP server, which takes JSON-RPC by POST only`, before
  any authentication or work: an old client probing for the removed GET
  stream costs nothing.
- **Numbers are numbers.** `remaining_hours` is a finite JSON number from
  0 that rounds to at most 99,999.9, rounded to one decimal place (or `null`
  to clear), the same limit REST and the app use. So `99999.94` saves
  `99999.9`. Any other number, numeric overflow such as `1e309` included,
  is refused with `remaining hours must be a number from 0 to 99,999.9.
  Enter a number in that range.`, before anything is compared. Task dates are real calendar days in `YYYY-MM-DD`
  form (or `null` to clear), so impossible dates are refused instead of
  rolling into the next month. Timestamps are full ISO strings.
  `plannable_hours` is integer-or-null — for an agent it is `null` (0103),
  the absence of a weekly capacity, not a small one.
- Conformance runs twice: `convex/tests/mcp.test.ts` (part of
  `npx vitest run`) pins the in-repo dispatch, and
  `tests/contract/mcp.test.mts` (`npm run test:contract`) replays its
  byte-stable subset over the real wire against a running deployment.
