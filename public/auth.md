# Connecting an agent to Qivo

Qivo uses credentials created by a signed-in person or organization admin.
Each credential acts as one Qivo user within one organization, with that
user's current permissions. Read [skill.md](https://qivo.io/skill.md) for
workflows and [llms.txt](https://qivo.io/llms.txt) for documentation discovery.

**OAuth is the preferred way for a person to connect their assistant to
Qivo's MCP server.** The person signs in and approves access in the browser;
the assistant receives its credentials directly, without copying a token.

## Choose a credential

| Credential | Acts as | Accepted by |
| --- | --- | --- |
| OAuth connection | The person who approves it | MCP and REST webhook management |
| Personal token, `qvt_…` | The person who created it | MCP and the organization REST API |
| Agent key, `qva_…` | A named agent user | MCP and the organization REST API |

Start with OAuth for a person's assistant. Use a personal token as a fallback
when the client lacks compatible OAuth support but accepts a custom
Authorization header, when the user explicitly requests manual setup, or for
REST requests that should act as that person. Use an agent key for automation
with its own identity, project access and attribution. Agents cannot be
organization admins, so actions only a person may take, such as setting
someone's plannable hours, need a person's credential.

## Connect a person's assistant with OAuth

For OAuth, add `https://api.qivo.io/mcp` to the assistant's remote MCP
connections and start its authorization flow. Sign in to Qivo, review the
app, organization and requested access, and choose **Connect**. The
default request includes reading, changes and automatic renewal. **Allow
changes** starts on for a write request; turn it off for reading only. The
client receives its credentials directly; the person does not copy a token.
Only approve a connection you started in the intended assistant.

OAuth clients use authorization code with S256 PKCE, authorization-server
discovery and dynamic client registration. Qivo does not implement Client ID
Metadata Documents, device-code approval or WorkOS `auth.md` registration
endpoints. OAuth client registration creates no Qivo user or project access;
a signed-in person must approve access. OAuth access tokens are bound to the
MCP server, so on REST they reach only webhook management; REST task, project
and user routes take personal tokens and agent keys.
The MCP endpoint's initial HTTP 401 challenge advertises
`qivo:read qivo:write offline_access`; clients can request a smaller scope set.

## Manual credentials

Use these steps for a personal-token fallback or a named agent's key:

1. Have the user sign in at [Qivo](https://qivo.io/app).
2. For a personal token, open **Settings → User account → MCP access →
   Personal access tokens**, enter a name and choose **New token**. Tokens
   created there can make changes and never expire. A choice of read-only
   access and an expiry date is planned. The same token works with MCP and
   the REST API.
3. For an agent key, an organization admin opens **Settings → Organization →
   Users**, creates an **Agent**, and copies its key. Existing agents can
   receive another key from their row. Grant the agent the necessary project
   access directly or through a team using the project's **Project access**
   list. Set its organization role to **Viewer** for read-only automation.
   Its keys can then only read.
4. Store the full secret in the client's credential settings or secret store.
   It is shown once; Qivo retains only its hash and a display identifier.

## Connect and verify

- **MCP:** `https://api.qivo.io/mcp`, using Streamable HTTP and the client's
  OAuth connection, or `Authorization: Bearer <full-qvt-or-qva-secret>`.
  Discover the tools through the MCP client, then call `get_me` to check
  who the credential acts as and whether it can make changes
  (`credential.access` is `write` or `read`). Call `list_projects` to verify
  readable access and `list_tasks` with a returned project reference to read
  its tasks. Task tools include `list_tasks`, `get_task`, `create_task`,
  `update_task`, `delete_task` and `set_task_link`. `tools/list` names every
  tool, including those for comments, labels, files, the inbox, projects and
  teams. Refresh discovery or reconnect if the client has an older tool
  catalogue.
- **Organization REST API:** `https://api.qivo.io/v1`, using
  `Authorization: Bearer <full-qvt-or-qva-secret>`. `X-Api-Key` is also
  accepted by REST. Check the credential with `GET https://api.qivo.io/v1/me`, which
  returns its user, kind and access, verify readable access with
  `GET https://api.qivo.io/v1/projects`, then use
  `GET /v1/tasks?project=<ref>` for tasks in a returned project and
  `GET /v1/tasks/{ref}` for one task, on the same API origin.

Manual credentials use the exact `Bearer ` prefix. Send personal tokens and
agent keys only to the intended Qivo API origin over HTTPS. OAuth clients
follow the discovered authorization-server endpoints for authorization, code
exchange and renewal, and send access tokens to the Qivo MCP resource. Keep
tokens and keys out of URLs, tasks, comments and public output. OAuth access
tokens can also authenticate `/v1/webhooks` management requests, and no other
REST route. A successful empty project list means no matching visible active
projects; it is not an authentication failure.

## Configure a task event receiver

Task events use REST webhooks with an agent key or personal token, or the
draft MCP Events extension with a valid MCP credential. OAuth subscriptions require `qivo:read`
and stay bound to the approved organization. A read-only agent can subscribe
to events it can read. Registering grants no additional project access.

The integration must host a public HTTPS callback on port 443. Qivo rejects
private/local destinations and redirects. Generate a separate Standard Webhooks
signing key, `whsec_` followed by the base64 encoding of 24 to 64 cryptographically
random bytes. Store it at the receiver and send it as `delivery.secret` when
subscribing. Never use the agent key, OAuth token or personal MCP token as the
webhook signing key, and never send those Qivo credentials to the receiver.
Qivo encrypts the stored signing key and does not return it in listings.

Verify each callback using `webhook-id`, `webhook-timestamp` and
`webhook-signature` with the Standard Webhooks signing key. Use a compatible
verification library rather than rebuilding the signature algorithm.
`X-MCP-Subscription-Id` identifies the subscription. Registration sends
`{ "type": "verification", "challenge": "<random value>" }`; verify the signed request, then return a
`2xx` JSON response containing `{ "challenge": "<same value>" }`. The response
itself does not need a signature. Reject invalid request signatures.

Use [the event workflow](https://qivo.io/skill.md#receive-task-events) to register,
inspect and remove subscriptions. There is no Qivo webhook settings UI.
REST subscriptions default to no expiry; MCP subscriptions default to seven days.
Send `ttlMs: null` for no expiry on either interface. Renew finite subscriptions
before `refreshBefore`. Existing subscriptions keep their expiry until registered
again, when the same TTL rules apply. Positive integer lifetimes are clamped
between 60 seconds and seven days.

OAuth subscriptions belong to the approved connection grant, independently of
its current access token. Access-token expiry, rotation or revocation of an
individual access token does not cancel subscriptions. Disconnect the connected
app or unsubscribe to stop them. A newly approved connection is a different
owner. Continue renewing access tokens for later MCP and webhook-management
requests.
Qivo rechecks the owning credential or grant and project visibility before
delivery. Grant or key revocation, deactivation, lost project access and
unsubscribe stop further attempts. A request already in flight may still arrive.

Continued delivery failures across seven days disable the subscription when a
further attempt fails. An acknowledgment clears the failure streak. Fix the
receiver and register again to verify and re-enable it. Renewing an active
subscription preserves its failure streak and health history. Recovery from a
disabled state clears the streak while keeping historical success, failure and
HTTP status. A finite subscription can expire before the health window elapses
unless renewed. A `410` callback response
stops only that event and leaves the subscription and its failure streak unchanged.
`408`, `425` and `429` retry. Pending retries survive a verified refresh before expiry.
Registering after expiry or deletion cannot revive old queued events. Signing-key
refreshes allow both old and new signatures for five minutes; receivers must
accept rotation during that window.

Inspect your own subscriptions with `GET /v1/webhooks` using the same personal
token, agent key or a current access token from the owning OAuth grant.
Organization administrators can inspect and remove organization subscriptions
through `/v1/webhooks/organization` with a personal token or OAuth connection.
Removing another owner's subscription needs a credential that can make
changes: a personal token with change access, or an OAuth connection with
`qivo:write`. Managing your own subscriptions works with a read-only
credential and, for OAuth, requires only `qivo:read`. No listing exposes
signing keys.

## Scope and permissions

A credential belongs to its user's organization. A personal token does not
combine all organizations visible in the browser. For automation in another
organization, have that organization's admin create an appropriately granted
agent there, and keep its credential and task references separate.

An OAuth connection is permanently bound to the organization shown during
approval: the person's home account, or the first active guest account for a
guest-only login. It does not follow later changes to the home account.
OAuth read access permits discovery and readable MCP tools; write access is
an additional ceiling and never overrides the person's current permissions.

Each credential either can make changes or can only read. An OAuth
connection can make changes only with `qivo:write`. A personal token can make
changes only if it has change access and has not expired; a token stored
without an access setting can only read. Every token created in the app today
has change access and never expires. An agent key can make changes only for an
agent whose organization role is **Standard user**; a **Viewer** agent's key
is read-only. A read-only credential still reads everything its user can and
manages its own task event subscriptions, but Qivo refuses every change before
it looks up the task or project you named. An agent key gets `this agent is a
Viewer and can only read`, a personal token gets `this credential can only
read`, and an OAuth connection without `qivo:write` gets the MCP 403
`insufficient_scope` challenge.

Project access follows the user's direct grants, current team memberships
and applicable leadership rights. Sub-projects inherit access from their
meta-project. A project **Viewer** role permits reading; **User** and **Lead**
permit task writes. An organization **Viewer** role caps every project at
read-only and grants no project access by itself. Credential creation does
not grant additional permissions. Only a person changes who has access to a
project, hands over its lead or changes a team's members and leaders, so an
agent's key cannot grant access, even to itself.

## Revocation and connection failures

Delete OAuth connections under **Settings → User account → MCP access → Connected
apps**. Deleting removes the connection from the list and prevents subsequent
access and refresh requests. Previously revoked connections can also be
deleted. Connecting again requires fresh approval in the assistant. OAuth
access tokens expire; clients can renew them with a rotating refresh token
when offline access was approved. Reusing a consumed authorization code or
refresh token revokes that connection, so clients must serialize refreshes.

Personal tokens are revoked on **MCP access**; admins revoke agent keys from
the agent's **Users** row. Revocation takes effect on subsequent requests.
Switching a user to **Inactive** disables all their credentials. Agent keys
and personal tokens have no refresh-token flow, and neither expires on its own
today, because the app creates personal tokens without an expiry date. Once
choosing an expiry date is offered, a token is refused after its date, like a
revoked one. To rotate, create a replacement, update and verify the client,
then revoke the old one.

- **HTTP 401:** An initial unauthenticated MCP request starts OAuth discovery;
  let the client follow its authorization flow. For an existing connection,
  the credential may be expired, revoked or invalid, or its user inactive or
  unavailable. Let the OAuth client renew access or reconnect with the
  person's approval. For manual credentials, check configuration and ask the
  owner/admin to restore access or create a replacement.
- **REST 401 for a personal token:** `unknown personal access token`,
  `this personal access token has been revoked or has expired` or
  `this account has been deactivated`. A missing credential answers
  `missing agent key (Authorization: Bearer qva_…)` whatever was meant.
- **REST 403:** Authentication succeeded, but the operation is forbidden. A
  Viewer agent's key answers `this agent is a Viewer and can only read` and a
  personal token without change access `this credential can only read` for
  every change. Both can still create, list and remove their own task event
  subscriptions. A credential that can make changes on a project its user
  cannot edit gets `your account has no write access to that project`
  (`this agent has no write access to that project` for an agent key).
- **MCP 403 with `insufficient_scope`:** The OAuth connection lacks the
  requested read or write access. Start a new approval for the required access.
- **REST 404:** The route or resource is absent, or the resource is unreadable.
  Check the current `/v1/tasks` route, organization and project access, and
  task reference. Former task endpoint names are not aliases.
- **MCP tool errors:** Inspect `isError` and the returned message; an HTTP
  success alone does not establish that the operation succeeded.

See the [automation guide](https://qivo.io/docs/automation-ai-the-rest-api-and-the-mcp-server/)
for product context. Separate operator-issued `qvc_` curation keys cannot
access organization projects or MCP tools.
