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
  and the client then acts as them. These permanent tokens do not expire
  automatically and remain a secondary option below the OAuth
  setup and its copyable MCP server address.
- **An agent's key.** An agent is a user of the organization that is not a
  person — no email, no password — created by an org admin under **Settings →
  Organization → Users**, where it is given a name and a key (`qva_…`,
  migration 0100). The client acts as the agent, which reaches exactly the
  projects the agent was given a role on. This is also the credential the
  [organization REST API](rest-api.md) takes, so one key serves both surfaces.

Global background curation uses the separate
[curation REST API](rest-api.md#background-curation-api) and an operator-issued
`qvc_` key. MCP accepts `qvo_`, `qvt_` and `qva_` credentials and exposes no
curation tools. Use the curation REST routes to browse images, submit source
links and record agent prechecks; final image approval and calendar assignment
remain operator actions in Qivo.

Everything below is written against *the user the credential resolves to*,
with OAuth scopes imposing an additional ceiling on that user's access.

Every tool call runs as that user, through the same access layer the app
itself queries: readable data stays within the user's access, and writes
require both the user's permission and, for OAuth, an approved write scope.
Projects and sub-projects have named leads and no owning team; products can
span teams through explicit access grants. Projects can be shared with teams as well as individual users. A team grant
applies to its current members as `user` or `viewer`, and the strongest direct
or team grant wins under the organization Viewer ceiling. Grants on a project
inherit to its sub-projects; a child grant does not spill to siblings.
Removing membership removes that access path while preserving
any direct grant or access through another team. Sharing with a team's leader
does not give them ownership rights over another team's project. Manage these
grants in the app's **Project access** list; MCP's tool shapes are unchanged.
Revoking a credential cuts access immediately — and so does switching the
user to **Inactive**, which stops every key or token they hold at once
without anything having to be revoked one by one: both the credential row
and the profile behind it are read fresh on every request.

**A read-only credential.** A user whose **organization role** is `viewer`
(migration 0102) holds a seat and signs in, reads exactly the projects they
can access directly or through a team, and writes nothing: every writing tool
is refused with the same
"your account has no write access to that project" a missing grant produces,
and they are never handed a task. It is a ceiling, not a grant — it opens no
project, it only refuses to let any other path (an individual or team grant, a
project-lead title, a team leadership) exceed read. An **agent** can be a
viewer too, which is how a read-only key is made: one setting on the Users
page instead of a grant list audited project by project. Nothing here
implements any of it — the cap lives in the shared access layer
(`cappedLevel` in `convex/lib/access.ts`), so the same profile is read-only
over MCP, over the REST API and in the browser alike.

Note that `viewer` is also the name of the lowest **project** role — a grant on
one project. The two are the same idea one altitude apart, which is why they
share a word; `list_users` reports the organization role as `org_role`, and no
tool payload carries a project role at all.

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
management tools.

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
  `ttlMs` (an hour) and `cacheScope: "private"` — the twelve tools are
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
`tools/call`, the same twelve tools, one fresh server per request. That leg
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
the app, REST and MCP model paths, scheduling cascades, subtree archiving,
restoration, automatic archiving and profile-removal cleanup. No-op updates do
not emit events. Comment edits/deletes, labels, links, attachments, project
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
credential was revoked or deleted, or whose account was removed. Temporary
deactivation and lost project access do not remove subscriptions.

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
OAuth administrator deletion requires `qivo:write`; ordinary ownership-based
subscription management needs only `qivo:read`.

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
(renameable — prefer numbers/uuids in anything stored), or a uuid.
The website, MCP and REST share the same noun: **task** for one work item
and **tasks** for collections. MCP uses `list_tasks` for the collection and
`get_task`, `create_task`, `update_task`, and `delete_task` for individual
operations. This pre-launch rename replaces the former tool names; clients
with a cached tool catalogue must refresh discovery or reconnect.

| Tool | What it does |
|---|---|
| `list_teams` | Teams in your organization, as `id` and `name` — teams group users for project sharing and administration. `list_projects` reports explicit team grants separately; neither project type has an owning team (renamed from `list_workspaces` by migration 0078) |
| `list_projects` | Projects (meta + sub) you can see, each with its durable `num`; both types have a lead and a nullable legacy `team_id` that is `null` for new rows, while team sharing remains explicit access; ACTIVE ones by default — `archived: true` lists the ones that have been put away instead (0106) |
| `list_tasks` | Filter by `project` (number/key/uuid; metas include their subs), `status`, `priority`, `assignee_id`, `search` (all word fragments across task ID, title and description, case-insensitive and in any order; `*` stays literal), `limit`; every result includes reporter, assignee and reviewer. `assignee_id` matches the stored assignee, also while a reviewer owns the task. Active tasks only by default — `archived: true` lists the archived ones instead (0070). Tasks in an ARCHIVED PROJECT are left out entirely unless `project` names that project (0106) — a different axis, and the one without a flag |
| `list_users` | Every Qivo user in the organization, for general roster discovery. The row is `id`, `name`, `org_role`, `kind`, `active`, `plannable_hours` — no email address and no profile picture. Presence here does **not** prove access to a destination project; use `list_project_users` before writing `reporter_id`, `assignee_id` or `reviewer_id`. `plannable_hours` is the **whole** hours a week that user has for **planned project work** (the work week minus meetings and other overhead). It is what the planner divides by: plan someone at most that many hours in a week, shared across every project they work on (0092). It is **`null` for an agent** (0103), whose capacity is unbounded, never zero |
| `list_project_users` | Users who can see `project` (number/key/uuid), and therefore valid non-null `reporter_id` values. It returns the `list_users` shape plus `assignable`: only active users with effective project Edit (`user`) or Lead access have `assignable: true` and are valid new `assignee_id` or `reviewer_id` selections. Inactive users and users with only View access remain valid reporters when they can see the project, because reporter is attribution rather than work or permission |
| `get_task` | One task with full description and reporter, assignee and reviewer; `ref` is `QN-482`, `482`, or a uuid — resolves archived tasks too (`archived_at` is non-null on them) |
| `list_comments` | The task's discussion thread, oldest first, with author and edit attribution |
| `add_comment` | Comment on a task **as yourself** (the credential's user is the pinned author); markdown body; returns the comment `id`, task reference as `task`, and `created_at`; leaves no activity row — the comment is its own feed entry |
| `create_task` | New task in a sub-project you can write to; `project` names it directly, or names a meta with `sub_project` naming one of ITS subs — another project's sub-project is a hard error (moving tasks is the app's Move dialog). Optional `reporter_id` is a user returned by `list_project_users`; omission defaults it to the credential's user. `null` is refused, and the reporter cannot be changed after creation. Optional `reviewer_id` follows the `assignee_id` rule. Created straight into `review`, the task gets its project's review time as `remaining_hours` unless the call sends hours. `title` is capped at 80 characters |
| `update_task` | Patch title/description/status/priority/assignee/reviewer/due date/remaining hours/paused (`paused: true` holds work; only a To Do, In Progress or In Review task can be paused, and a move to Done or Backlog resumes it), plus `archived: true/false` to archive/restore (archiving carries the subtasks along; restoring surfaces the parent chain). The reporter is immutable: any `reporter_id` argument, including `null` or the current reporter, is refused before any other field is changed. `title` is capped at 80 characters. The result's `updated` lists the fields you sent (and `archived_at` for a toggle), never a value the server set on its own, such as the review time |
| `delete_task` | Delete a task (attachment bytes are reaped) |
| `update_user` | Set a user's `plannable_hours`. Allowed for an **organization admin**, or a **leader of a team that person belongs to** — nobody else, your own account included; an agent is never an organization admin (0100/0102), so a leaked key cannot rewrite the organization's capacity plan. The database decides (0094), so a refusal here is the same refusal the app gives; the value is a **whole number of hours**, 1 to 168 — the schema turns a fraction away (0095). It applies to **people only**: an agent has no plannable week and cannot be given one (0103, "an agent has no plannable week — its capacity is unbounded"), refused by the tool and by the RPC underneath |

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
permission downgrade and updates that omit `assignee_id`. Any explicitly
supplied non-null `assignee_id`, even the current value, requires current
eligibility.
`reviewer_id` follows the same rule: only a row with `assignable: true` may be
a reviewer, and `null` clears it. The refusal sentences are the assignee's,
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
longer in the `create_task`/`update_task` schemas, and an argument the
schema doesn't know is stripped before the tool runs — a client still sending
`estimate_hours` silently changes nothing; update it. A task **with
active subtasks** has no remaining time of its own (0066; archived
subtasks stopped counting in 0070): `update_task` with a
non-null `remaining_hours` for one is an error — usually "remaining_hours
cannot be set on a task with subtasks — it is the sum of their remaining
time", though when every subtask lives in a project hidden from your
account the model guard surfaces instead ("a task with
subtasks has no remaining time of its own — it shows the sum of its
subtasks") — so match on "remaining time", not the exact sentence. `null`
passes as a no-op. The hours live on the subtasks, and the app shows the
parent's value as their recursive sum; such tasks read back
`remaining_hours: null`.

Tasks also read back `remaining_set_at` (0072) — the server-stamped moment
`remaining_hours` was last saved. A remaining time is a measurement, and the
app's planning math anchors on when it was taken. The stamp moves only when
the value genuinely *changes* (re-sending the same number is a no-op there),
clears together with the hours, and cannot be written over MCP: it is not in
any tool schema, so the server strips it like every unknown argument.

A task that enters `review`, created there or moved there, gets its project's
review time as `remaining_hours` (2 hours unless the project lead sets
another in the app), with a fresh `remaining_set_at` even when the hours are
unchanged. A non-null `remaining_hours` in the same call wins; `null` or no
value takes the review time. Leaving `review` keeps whatever is left, and a
call that stays in `review` changes nothing. `update_task` does not add
`remaining_hours` to `updated` for this; read the task back to see it.

Archived tasks (0070) are a separate axis from `status`: they leave the
default `list_tasks` result, stop counting as workload, and in the app live
on the Archive page. Where the legacy per-team setting applies, restoring a
still-`done` task restarts its auto-archive clock (0071), so a restore holds
for the full threshold. New teamless projects have no automatic archive
threshold yet.
`create_task` rejects `archived` outright (tasks are created active) — the
key is declared in the schema precisely so it can't be silently stripped
like an unknown argument.
In the app, archiving unfinished work requires a written reason (stored as a
comment); `update_task { archived: true }` does not enforce that — add one
with `add_comment` when a reason is worth keeping.

Archived **projects** (0106) are the same idea one altitude up, and a
separate axis again. A project that has been put away in the app keeps
everything it had, but it is not part of the working set: it is absent from
`list_projects` unless you pass `archived: true`, its tasks are absent from
`list_tasks` unless `project` names it, and `create_task` into one is
refused with a sentence naming the project to restore. Naming a LIVE project
asks for it as it stands, so a sub-project archived out of it stays out;
naming an archived one asks for it as it was put away, and everything under
it comes. There is no tool that archives or restores a project — that is a
project lead's decision, taken in Settings.

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

There is no subscribe tool, and no tool argument is involved in any of this.
Subscribing is a person's own notification preference, expressed in the app;
this surface exposes no inbox to read one back, and no tool here writes into
anybody else's personal space. The server does the rest, inside the same
transaction as the write.
Unknown/out-of-org uuids and users without visibility into the project are
silently skipped — a subscription never outlives the project access that
justified it.

Tool errors are readable sentences ("not found (or not visible to you)",
"your account has no write access to that project") — a denial by the access
layer looks like the object not existing, matching the app.

## Implementation notes

- Hand-rolled stateless JSON-RPC over one POST route — a Convex HTTP action
  (`convex/machine/mcp.ts`), no MCP SDK. The credential is resolved before
  dispatch; OAuth additionally rechecks the live grant and scopes before each
  tool, including every call in a batch. Every tool is one internal Convex function that
  takes the resolved user explicitly and re-asserts it — ref resolution, the
  rules a write must satisfy, the write and its activity trail, all in one
  transaction. What the surface file itself holds is the MCP grammar: the
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
  credentials retain their three refusal sentences —
  `missing credential (Authorization: Bearer qvt_… or
  qva_…)`, or per credential kind `unknown, revoked or deactivated agent
  key` / `unknown or revoked MCP token` — the credential's exact state is
  deliberately not disclosed.
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
