# Qivo MCP server

The temporary `demo.qivo.io` service is browser-only: it does not issue or
accept external agent credentials or OAuth connections. Use a regular Qivo
workspace for this interface.

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
and the `set_task_link`, `list_labels` and `set_label` tools. `create_task`
and `update_task` name any argument they do not know in
`ignored_arguments`, so a client with an older catalogue sees what it sent
in vain.

Parity with the app also added `get_me`; `update_comment` and
`delete_comment` for comments; `list_inbox`, `update_inbox` and
`set_following` for the inbox and follows; and `delete_attachment`,
`list_task_activity` and `get_workload` for files, task history and workload.
`create_task` now also takes `paused`. A client holding an older catalogue
does not see these until it refreshes its tool list.

Project parity added `get_project`, `create_project`, `update_project`,
`set_project_access`, `set_milestone` and `delete_milestone`. A client
holding an older catalogue does not see them until it refreshes its tool
list. `update_project` also names any argument it does not know in
`ignored_arguments`, such as an `archive_reason`, which only tasks take.

Team parity added `set_team` and `set_team_member`, and `list_teams` now
answers each team's `members`. A client holding an older catalogue still
reads the new field, but does not see the two tools until it refreshes its
tool list.

## Access model: the credential is a user

MCP authenticates as **one user**, with three connection options. **OAuth is
preferred when a person connects their assistant.** Personal tokens remain
a fallback for clients without compatible OAuth support or for explicitly
requested manual setup; agent keys give automation its own identity.

- **OAuth approval.** A supported client opens Qivo's browser sign-in and
  consent screen. Approval binds the client to the displayed home profile
  and organization. The default request includes `qivo:read`, `qivo:write`
  and `offline_access`; the person can turn off **Allow changes** to approve
  reading only. Opaque access tokens (`qvo_…`) and rotating refresh tokens (`qvr_…`, when
  `offline_access` is approved) go directly to the client. Delete the
  connection under **Settings → User account → MCP access → Connected apps**
  to stop its access and remove it from the list. Previously revoked
  connections can also be deleted.
- **A person's token.** Each person mints their own under **Settings → User
  account → MCP access → Personal access tokens**; the secret (`qvt_…`, shown once,
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
and the profile behind it are read fresh on every request.

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
A read-only credential still reads everything its user can, and it can still
create, list and remove its own [webhook subscriptions](#task-events-and-webhook-delivery).

**The Viewer role.** A user whose **organization role** is `viewer`
(migration 0102) holds a seat and signs in, reads exactly the projects they
can access directly or through a team, and changes no project. A Viewer
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
actor and detail `via MCP` — an update's row names both sides of every
changed field first, e.g. `(status To Do → In Progress, remaining
80 h → 40 h) — via MCP`; description edits quote both sides as ~80-char
excerpts (`description “old…” → “new…”`). Task numbers come from the
shared per-org counter. Comments are
the deliberate exception — adding one writes no activity row, matching the
app, where the comment itself is the feed entry on the discussion spine.
So is `update_user`: capacity is a setting on a person, not an event in a
project's history, and the app writes no feed row for it either.

## Request limits and billing

MCP and the organization REST API share **300 authenticated HTTP requests per
profile per minute**, across that profile's agent keys, personal tokens and
OAuth connections. A deployment-wide **6,000-request-per-minute** limit applies
before authentication. Both limits use fixed minute windows. MCP limits apply
to POST requests; CORS preflights do not consume them.

Rate limiting returns HTTP `429` with `Retry-After: 60`. Wait 60 seconds before
retrying. Each authenticated POST that passes rate limiting counts once toward
the organization's pooled API allowance during a recorded billing period,
including discovery, invalid tool arguments, permission refusals and other
protocol or routing errors. A batch is still one HTTP request. Missing or
invalid credentials and rate-limited requests do not add billable calls. OAuth
MCP requests follow the same metering and limits as personal tokens and agent
keys; this does not meter authorization or token-exchange endpoints as tool
calls.

When enabled organization billing has expired or needs payment, writing tools
return a readable billing refusal while reading keeps its normal access rules.
An organization admin restores editing through **Settings → Organization →
Billing**, where they can subscribe, open the customer portal and inspect
usage by account and key or OAuth connection. MCP does not expose billing subscription
management tools. While writes are paused, an organization admin can still
revoke or delete agent keys and make users Inactive in the app, and people can
still revoke their own personal tokens and OAuth connections. Each of these
also stops reads with the affected credentials.

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

The MCP endpoint advertises its protected-resource metadata in
`WWW-Authenticate` on HTTP 401, and serves
`/.well-known/oauth-protected-resource/mcp` plus the root alias. The metadata
names the canonical MCP resource and authorization server. Use those values
for discovery instead of guessing authorization or token endpoints.
The initial 401 challenge advertises
`scope="qivo:read qivo:write offline_access"` so clients following it request
normal task access and automatic renewal. A client can request a smaller
scope set, and consent can remove write access.

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
other REST routes and background curation.

Each approval has an immutable user, profile, organization, client and
resource binding. Revocation, inactive or removed membership, and the
provider token's expiry are checked when authenticating requests. Deleting a
connection prevents access and refresh and hides the grant from the person's
list. Its revoked grant and replay hashes are retained so old signed consent
and credentials cannot revive it. Reuse of a consumed code or refresh token revokes the
connection, including credentials issued by a concurrent refresh; clients
must serialize refresh requests. A fresh connection creates a new grant.

The Better Auth provider is pinned to `1.6.31`, which remains in the affected
range of the resource-binding advisory
[GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528)
and is still reported by `npm audit`. The reported scenario lets a client
approved for one service obtain a token for another configured service.
Qivo has one allowed audience and uses opaque access tokens rather than JWT
access tokens, avoiding that cross-service scenario in the current
configuration. The upstream 1.6 release is still unpatched. Qivo additionally
checks resource parameters and stores an immutable resource binding on each
grant; regression tests cover foreign and repeated resource indicators and
the canonical default when omitted.

The fix is in the 1.7 release line, but the current Convex adapter declares
`better-auth >=1.6.11 <1.7.0`. Upgrade the adapter and provider together when
compatible. Do not add another audience without revisiting these checks and
the provider upgrade.
The [pending security upgrade checklist](better-auth-upgrade.md)
records the release conditions, package/schema steps, required regression
checks, safeguards to retain and rollback criteria for that upgrade.

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

Available events are `task.created`, `task.updated`, `task.deleted` and
`comment.created`. `task.updated` covers stored task-field changes made through
the app, REST and MCP model paths, subtree archiving, restoration, automatic
archiving and profile-removal cleanup. No-op updates do not emit events. A
group's dates are calculated from its subtasks, so a subtask date change emits
no event for the group. Comment edits/deletes, labels, links, attachments, project
changes and seed/import writes do not have event types in this version.
Project and organization deletion do not deliver events for their removed tasks.
Deleting a project can still emit `task.updated` when it detaches a child task
in a surviving project.

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
On MCP, omitting `ttlMs` requests seven days. A positive integer `ttlMs` is
clamped to a minimum of 60 seconds and a maximum of seven days. Zero, negative
and non-integer values are refused. Send `ttlMs: null` for no expiry. Qivo returns
`refreshBefore: null` for these subscriptions, which need no renewal.
REST defaults to no expiry when `ttlMs` is omitted. Existing subscriptions keep
their stored expiry until registered again.
Each registration applies these rules, so an MCP renewal that omits `ttlMs` sets
a new seven-day expiry even if the subscription previously had no expiry.
Renew finite subscriptions before `refreshBefore`. There is no replay; non-null
cursors are refused. Events occurring without an active subscription cannot be
recovered through this interface. Limits are 20 unexpired subscriptions per
credential or OAuth grant and 100 per organization, including disabled
subscriptions retained for inspection.
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
deletion and comment events use an empty `changed_fields` list. A deleted task
cannot be fetched afterward. `changed_fields` contains stored task-column names,
including server-maintained fields such as `remaining_set_at`. These names do
not form an API write payload. Names can include `created_by`, `done_at`,
`review_at`, `start_week`, `end_week` and `parent_id`. For example, the event
reports `archived_at`, while a machine API write uses `archived`. Changes only
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
`set_label` for the organization's labels, `delete_attachment` and
`list_task_activity` for a task's files and history, `get_workload` for
planned hours per person, `update_comment` and `delete_comment` for comments,
`list_inbox` and `update_inbox` for your inbox, `set_following` to follow a
task, `get_project`, `create_project`, `update_project`,
`set_project_access`, `set_milestone` and `delete_milestone` for projects,
and `set_team` and `set_team_member` for teams. This pre-launch rename
replaces the former tool names; clients
with a cached tool catalogue must refresh discovery or reconnect.

| Tool | What it does |
|---|---|
| `get_me` | Who the credential acts as, as `user` (the `list_users` row plus `email`, `null` for an agent), `organization`, `billing` and `credential`. See [Who am I](#who-am-i). Call it first |
| `list_teams` | Teams in your organization, as `id`, `name` and `members` (`id`, `name`, `leader`, by name). Teams group users for project sharing and administration. A team's project grants are in `get_project`, and `list_project_users` shows who has access through them. Neither project type has an owning team (renamed from `list_workspaces` by migration 0078). See [Teams](#teams) |
| `list_projects` | Projects (meta + sub) you can see, each with its durable `num`; both types have a lead and a nullable legacy `team_id` that is `null` for new rows, while team sharing remains explicit access; ACTIVE ones by default — `archived: true` lists the ones that have been put away instead (0106) |
| `list_tasks` | Filter by `project` (number/key/uuid; metas include their subs), `status` (one status or a list of them), `priority`, `assignee_id`, `owner_id`, `search` (all word fragments across the fields the app's task filter searches: task ID, title, description, status name except on a task with subtasks, priority name, assignee name and label names; case-insensitive and in any order; `*` stays literal), `limit` (50 by default, at most 200) and `offset`; every result includes reporter, assignee, reviewer and owner. `assignee_id` matches the stored assignee, also while a reviewer owns the task; `owner_id` matches whose work it is, the reviewer while the task is in review with one and the assignee otherwise. Active tasks only by default; `archived: true` lists the archived ones instead (0070). Tasks in an ARCHIVED PROJECT are left out entirely unless `project` names that project (0106). That is a different axis, and the one without a flag. Rows are ordered by project key, then task number, so `offset` pages through them |
| `get_project` | One readable `project` (number/key/uuid), as the `list_projects` row plus `lead_id`, `lead_name`, `review_hours` (its own, `null` when it uses its parent's or the default), `effective_review_hours`, `track_delay`, the top-level project's `milestones` and its own `grants`. See [Projects, access and milestones](#projects-access-and-milestones) |
| `create_project` | Create a top-level project from `name`, or with `parent` (number/key/uuid) a sub-project; optional `lead_id` (you by default) and `description`. Answers like `get_project` |
| `update_project` | Change a project you lead: `name`, `description`, `review_hours`, `track_delay`, `archived: true/false` to archive or restore it, and `lead_id` to hand over the lead (people only). Answers like `get_project`, plus `ignored_arguments` when you sent arguments the tool does not know, such as `archive_reason`, which only tasks take |
| `set_project_access` | Give one `user_id` or `team_id` `level` `user` or `viewer` on a `project`, or with `level: null` remove it, settling the open tasks it hides by `on_held_tasks`. People only, with Lead access |
| `set_milestone` | Add a milestone (`name`, `date`) to a `project`'s top-level project, or with `milestone` rename or move one |
| `delete_milestone` | Delete a `milestone` of a `project` |
| `set_team` | Without `team_id`, create a team called `name` (organization admins only); with `team_id`, rename it (an organization admin or a leader of the team). Answers the `list_teams` row with `created` |
| `set_team_member` | Add (`member: true`) or remove (`member: false`) one `user_id` in a team, and with `member: true` make or unmake them a leader (`leader`). People only, as an organization admin or a leader of the team. A removal settles the user's open tasks by `on_held_tasks` |
| `list_users` | Every Qivo user in the organization, for general roster discovery. The row is `id`, `name`, `org_role`, `kind`, `active`, `plannable_hours` — no email address and no profile picture. Presence here does **not** prove access to a destination project; use `list_project_users` before writing `reporter_id`, `assignee_id` or `reviewer_id`. `plannable_hours` is the **whole** hours a week that user has for **planned project work** (the work week minus meetings and other overhead). It is what the planner divides by: plan someone at most that many hours in a week, shared across every project they work on (0092). It is **`null` for an agent** (0103), whose capacity is unbounded, never zero |
| `list_project_users` | Users with access to `project` (number/key/uuid), and therefore valid non-null `reporter_id` values. On a parent project these are the people with access to the parent itself (organization admins, its lead and its individual or team grants); someone who reaches the parent only through one of its sub-projects is listed under that sub-project. It returns the `list_users` shape plus `assignable`: only active users with effective project Edit (`user`) or Lead access have `assignable: true` and are valid new `assignee_id` or `reviewer_id` selections. Inactive users and users with only View access remain valid reporters when they can see the project, because reporter is attribution rather than work or permission |
| `get_task` | One task with full description and reporter, assignee and reviewer, plus its `labels`, `subtasks`, `links`, `following`, `followers`, `attachments` with download links and, for a group, `group_remaining_hours` (see [Task results](#task-results)); `ref` is `QN-482`, `482`, or a uuid. It resolves archived tasks too (`archived_at` is non-null on them) |
| `list_comments` | The task's discussion thread, oldest first, with author and edit attribution |
| `add_comment` | Comment on a task **as yourself** (the credential's user is the pinned author); markdown body; returns the comment `id`, task reference as `task`, and `created_at`; leaves no activity row — the comment is its own feed entry |
| `create_task` | New task in a sub-project you can write to; `project` names it directly, or names a meta with `sub_project` naming one of ITS subs. Another project's sub-project is a hard error; move a task later with `update_task`. `parent` (a task ref) makes it a subtask; you need Edit access on the parent's project, because the parent becomes a group. `start_week` and `end_week` plan it (week starts, both or neither), and `paused` holds it. Optional `reporter_id` is a user returned by `list_project_users`; omission defaults it to the credential's user. `null` is refused, and the reporter cannot be changed after creation. Optional `reviewer_id` follows the `assignee_id` rule. Created straight into `review`, the task gets its project's review time as `remaining_hours` unless the call sends hours. `title` is capped at 80 characters. Returns `id` and `key`, plus `ignored_arguments` when you sent arguments the tool does not know |
| `update_task` | Patch title/description/status/priority/assignee/reviewer/due date/plan weeks/remaining hours/paused (`paused: true` holds work; only a To Do, In Progress or In Review task without subtasks can be paused, and a move to Done or Backlog resumes it), plus `archived: true/false` to archive/restore (archiving carries the subtasks along; restoring surfaces the parent chain) and `archive_reason`, posted as your comment when the call archives the task. It also moves the task (`project`, `sub_project`), sets or clears its parent (`parent`, `null` detaches) and adds or removes labels (`add_labels`, `remove_labels`, label ids or names). See [Moving, parents and labels](#moving-parents-and-labels). Both need User access on every project they change, so a subtask or parent the credential cannot edit refuses the toggle with `archiving this task would change a subtask in a project you cannot edit; an organization admin can archive it` or `restoring this task would change a parent task in a project you cannot edit; an organization admin can restore it`. The reporter is immutable: any `reporter_id` argument, including `null` or the current reporter, is refused before any other field is changed. `title` is capped at 80 characters. The result's `updated` lists the fields you sent (`parent_id` for `parent`, `project_id` for a move, `labels` for label changes, and `archived_at` for a toggle), never a value the server set on its own, such as the review time. `ignored_arguments` names arguments the tool does not know |
| `delete_task` | Delete a task (attachment bytes are reaped) |
| `set_task_link` | Add (`linked: true`) or remove (`linked: false`) the link between `ref` and `other`, with `kind` `blocks`, `blocked_by` or `relates` as seen from `ref`. Two tasks share at most one link. It needs read access to both tasks and Edit access on either, the app's rule. Adding the link that exists, or removing one that does not, changes nothing; `changed` in the result says whether the call did. A different link between the same tasks is refused with `these tasks are already linked`. `get_task` lists the links |
| `list_labels` | The organization's labels as `id`, `name` and `color`, ordered by name |
| `set_label` | Without `label`, create a label from `name` and `color` (`#` and six hex digits); this needs an organization admin, or a user (person or agent) with the User role and Edit access to a top-level project. With `label` (an id or name), rename or recolor that label; only organization admins may, as on the app's Labels settings page. Returns the label with `created` |
| `delete_attachment` | Delete a file attached to the task `ref`; `attachment` is an id from `get_task`'s `attachments`. It needs Edit access to the task's project, as in the app, and leaves description images (`inline: true`) to the app. See [Attachments](#attachments) |
| `list_task_activity` | The task's history, oldest first, as the task window's Activity shows it: `id`, `created_at`, `actor_id`, `actor_name`, `verb` and `detail`. See [Task activity](#task-activity) |
| `get_workload` | Each person's planned hours per week from the week holding `from_week` (default this week) for `weeks` weeks (1 to 52, default 8), optionally limited to one `project`. See [Workload](#workload) |
| `update_comment` | Replace a comment's `body`; `comment` is its `id` from `list_comments`. The comment's author may, and so may a lead of the task's project. See [Comments, inbox and following](#comments-inbox-and-following) |
| `delete_comment` | Delete a comment, by the same rule as `update_comment` |
| `list_inbox` | Your inbox as `items`, one per active task you can read, latest activity first, with `unread_only`, `include_snoozed`, `limit` (50 by default, at most 200) and `offset`. `truncated` says some messages were not looked at |
| `update_inbox` | `read`, `unread`, `remove` or `snooze` your items about `tasks`, or with `all: true` mark every item read or remove every read item. `snooze` takes `until` |
| `set_following` | Follow a task (`following: true`) or stop following it |
| `update_user` | Set a user's `plannable_hours`. Allowed for an **organization admin**, or a **leader of a team that person belongs to**. Nobody else may, your own account included. An agent is never an organization admin (0100/0102) and never leads a team (only people do), so a leaked agent key cannot rewrite the organization's capacity plan. The database decides (0094), so a refusal here is the same refusal the app gives; the value is a **whole number of hours**, 1 to 168, and the schema turns a fraction away (0095). It applies to **people only**. An agent has no plannable week and cannot be given one (0103, "an agent has no plannable week — its capacity is unbounded"), refused by the tool and by the RPC underneath |

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
  and `reason` is then the sentence every writing tool is refused with. No
  plan, price or usage is included.
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

`get_project` answers the `list_projects` row with these fields added:

```json
{
  "lead_id": "…uuid…", "lead_name": "Leo Martins",
  "review_hours": null, "effective_review_hours": 2, "track_delay": true,
  "milestones": [{ "id": "…uuid…", "name": "Prototype validated", "date": "2026-11-02" }],
  "grants": {
    "users": [{ "id": "…uuid…", "name": "Emil Strand", "level": "user" }],
    "teams": [{ "id": "…uuid…", "name": "Hardware", "level": "viewer" }]
  }
}
```

A sub-project without a lead of its own is led by its parent's lead.
`review_hours` is the project's own review time, and `effective_review_hours`
the time a task entering `review` gets. `milestones` belong to the top-level
project, so a sub-project shows its parent's, ordered by date. `grants` are
the project's own individual and team grants, as its **Project access** list
shows them; a sub-project also inherits its parent's. A project you cannot
read answers `project "<ref>" not found (or not visible to you)`, exactly
like an unknown one.

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
`archive_reason`, so a call that sends it still archives the project and names
the argument in `ignored_arguments`.

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

The removal and its choice land together or not at all. The result adds
`stranded`, `kept_as_viewer` and `reassigned`; `stranded` and `reassigned`
list `{id, key, title, user_id, role}`. `changed` is `false` when there was
no grant to remove. `on_held_tasks` with a level is refused.

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
rows, signed `via MCP`. Changes to the description, review time or delay
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
admin or a leader of this team` otherwise). `name` is trimmed and may not be
blank. The result is the `list_teams` row plus `created`. Neither writes an
activity row, as in the app. The team's other settings and deleting a team
stay in the app.

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
  tasks. The removal and its choice land together or not at all. The result
  is `{team, user, member: false, leader: false, changed}` plus `stranded`,
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

`get_task` adds seven fields, which name only tasks you can read:

```json
{
  "group_remaining_hours": 6.5,
  "labels": [{ "id": "…uuid…", "name": "Hardware", "color": "#4C9AFF" }],
  "subtasks": [{ "id": "…uuid…", "key": "QN-4", "title": "…", "status": "todo" }],
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
lists its active ones, and an archived task lists all of them. `links` are the
task's links whose other task you can read, `kind` as seen from this task.
`group_remaining_hours` is `null` for a task without subtasks. For a group it
is the remaining time the app shows, which is the sum over its unfinished
subtasks at any depth that you can read, or `null` when none has hours. Like
the group's dates, it counts only active subtasks of an active group, leaves
out subtasks in archived projects while the group's project is active, and
stops at a subtask you cannot read.

### Moving, parents and labels

`update_task` moves a task with `project` and `sub_project`, named as in
`create_task`; `sub_project` without `project` is refused. The move follows
the app's Move dialog. You need Edit access on the current and the
destination sub-project; a destination you can read but not write is
refused with `your account has no write access to that project`, and one you
cannot read reads `project "<ref>" not found (or not visible to you)`. The
task's assignee, and the reviewer of a task without subtasks, must be able to
work in the destination, and everyone working on its active subtasks must be
able to see it. A new `assignee_id` or `reviewer_id` in the same call is
checked against the destination. A moved task keeps its key, labels, links
and subtasks.

`parent` (a task ref) makes the task a subtask of that task, and `null`
detaches it. You need Edit access on the parent's project, because the
parent becomes a group and loses its own remaining hours. A parent you
cannot read reads `parent task "<ref>" not found (or not visible to you)`.
The task cannot become its own parent or a subtask of one of its subtasks,
an active task cannot go under an archived parent, and chains stop at 20
tasks. Everyone assigned to or reviewing the task or its subtasks must be
able to see the new parent.

`add_labels` and `remove_labels` take label ids or names in any case from
`list_labels`. Labels change one at a time, never as a replacement list, and
asking for a label the task already has, or removing one it lacks, changes
nothing. An unknown label, or one in both lists, is refused.

One call may combine all of it. It applies the move, then the parent, then
the other fields with the archive toggle, then the labels, then
`archive_reason`. Everything lands or nothing does, and each step writes its
own activity row signed `via MCP`.

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
that task reads `attachment "<id>" not found on QN-<n>`. MCP does not
upload files; scripts upload through the REST API. Description images stay
with the app, so `delete_attachment` refuses one with `this image belongs to
the task description; remove it by editing the description in the app`.
When `update_task` rewrites a description, keep every `![alt](att:<id>)`
reference whose image should stay. An image the description no longer names
stays until someone next saves that task's description in the app. That
save deletes the image at once if it was uploaded more than a day ago, so
put a dropped reference back before then.

### Task activity

`list_task_activity` answers the task's history, oldest first, the rows the
task window's **All** filter shows beside the comments (`list_comments` has
those):

```json
[
  {
    "id": "…uuid…", "created_at": "…",
    "actor_id": "…uuid…", "actor_name": "Leo Martins",
    "verb": "changed", "detail": "(status To Do → In Progress) — via MCP"
  }
]
```

You receive the rows the app's activity feed would give you. Organization
admins receive every row. Other users do not receive a row that names a
project they cannot access, such as where the task was before a move, or
another task they cannot read, such as the other end of a link. An
archived task's history is answered too, by the same rule. `actor_id` and
`actor_name` are `null` once the user who made the change has been removed
from the organization. The organization keeps its newest 500 activity rows.

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
  `get_me`. `weeks` is 1 to 52, 8 by default.
- `project` (number, key or uuid) limits the hours to that project and its
  sub-projects; `project` names it in the result.
- `hours[i]` is the week starting `week_starts[i]`, rounded to a tenth. A
  task counts toward its owner (the reviewer while it is In Review with one,
  else the assignee) when it is scheduled, not Done, not paused, has
  remaining hours and is not archived. Its remaining hours spread evenly from
  the week its estimate was saved, or its start week if later, through its
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

`set_following` follows a task (`following: true`) or stops following it.
Following needs only read access to the task, and the result's `changed`
is `false` when nothing changed. Followers receive the task's updates in
their inbox. Qivo also makes you follow a task when you are assigned or
handed it, mentioned on it or comment on it. You can change only your own
follow.

`list_inbox` answers your inbox as the app's **Inbox** shows it, one item per
task, latest activity first:

```json
{
  "items": [
    {
      "task": { "id": "…uuid…", "key": "QN-3", "title": "Fix hinge tolerance", "status": "progress" },
      "unread_count": 1,
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
tasks. A snoozed item loses its snooze. A snooze set on such an item later ends without making it unread. Messages that arrive while the task
or its project is archived, including the `Archived` message, mentions and
comments, are stored read. As with any read message, the nightly cleanup
removes them after the recipient's retention period, and `update_inbox`
with `action: "remove"` and `all: true` removes them too. A restore brings
back the items still stored, with their messages read. A restore that comes
before the marking leaves the messages as they were. Other followers of a
restored task also receive an unread `Restored` message, which replaces the
item's read messages as any new message does. Deleting a task or a project
deletes the messages about its tasks. `messages` run oldest first, `kind` is
`mention`, `comment` or `change`, and `detail` is the line the app shows.
`latest_at` is the newest message's time, or the end of a snooze when that
is later. Snoozed items are left out unless `include_snoozed` is `true`. An
item keeps at most 50 unread messages. When more arrive, Qivo drops the
oldest unread ones but keeps the item's first unread message and the newest
message of each `kind`.

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

`update_inbox` applies `action` to your items about `tasks` (task refs), or
with `all: true` to every item:

- `read` marks the items read and, like opening an item in the app, keeps
  only each item's latest message. With `all`, it marks every item read
  except snoozed ones.
- `unread` marks the items unread again.
- `remove` removes the items. With `all`, it removes every read message
  except snoozed ones and leaves unread messages alone.
- `snooze` hides the items until `until`, an ISO date-time in the future and
  at most a year ahead, and marks them unread, so they return bold.
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
`status cannot be set on a task with subtasks — update its subtasks instead`.
Removing, detaching or archiving the last active subtask restores the
parent's saved status. Archived parents retain `is_group: true` while they
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
longer in the `create_task`/`update_task` schemas. An argument the schema
does not know is dropped before the tool runs, so a client still sending
`estimate_hours` changes nothing; both tools name it in
`ignored_arguments`. Update the client. A task **with
active subtasks** has no remaining time of its own (0066; archived
subtasks stopped counting in 0070). `update_task` with a non-null
`remaining_hours` for one is refused with `remaining_hours cannot be set on a
task with subtasks — it is the sum of their remaining time`, also when you
cannot read the subtasks. `null` passes as a no-op. The hours live on the
subtasks, and the app shows the parent's value as the sum over its unfinished
subtasks; such tasks read back `remaining_hours: null`.

Tasks also read back `remaining_set_at` (0072) — the server-stamped moment
`remaining_hours` was last saved. A remaining time is a measurement, and the
app's planning math anchors on when it was taken. The stamp moves only when
the value genuinely *changes* (re-sending the same number is a no-op there),
clears together with the hours, and cannot be written over MCP: it is not in
any tool schema, so the server drops it like every unknown argument and
`update_task` lists it in `ignored_arguments`.

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
default `list_tasks` result, stop counting as workload, and in the app live
on the Archive page. A nightly sweep archives tasks that have been `done`
for 30 days, or for a legacy team archive setting's number of days where an
older project kept one. Restoring a still-`done` task restarts its
auto-archive clock (0071), so a restore holds for the full threshold.
`create_task` rejects `archived` outright, because tasks are created
active. The schema declares the key so that the call is refused. An unknown
argument would only be named in `ignored_arguments`, and the call would
still create an active task the client did not ask for.
In the app, archiving unfinished work requires a written reason, stored as a
comment. `update_task { archived: true }` does not require one, but
`archive_reason` in the same call posts it the same way, as your comment at
the moment of the archive. It is posted only when the call archives the
task, so not for a task that is already archived, and a blank reason posts
nothing. `archive_reason` without `archived: true` is refused.

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
  OPTIONS` and the body `stateless MCP server — POST JSON-RPC only`, before
  any authentication or work: an old client probing for the removed GET
  stream costs nothing.
- **Numbers are numbers.** `remaining_hours` is a finite JSON number from
  0 through 99999.9, rounded to one decimal place (or `null` to clear).
  Numeric overflow such as `1e309` is refused. Task dates are real calendar days in `YYYY-MM-DD`
  form (or `null` to clear), so impossible dates are refused instead of
  rolling into the next month. Timestamps are full ISO strings.
  `plannable_hours` is integer-or-null — for an agent it is `null` (0103),
  the absence of a weekly capacity, not a small one.
- Conformance runs twice: `convex/tests/mcp.test.ts` (part of
  `npx vitest run`) pins the in-repo dispatch, and
  `tests/contract/mcp.test.mts` (`npm run test:contract`) replays its
  byte-stable subset over the real wire against a running deployment.
