/* The /mcp surface: hand-rolled stateless JSON-RPC over one POST route.
 * The conformance oracle is the live capture of 44 exchanges taken from the
 * previous server before it was decommissioned. The load-bearing findings
 * reproduced here:
 *
 *   - The LEGACY (2025-era, envelope-less) leg answers in SSE framing —
 *     `event: message\ndata: <one-line JSON>\n\n`, Content-Type
 *     text/event-stream + Cache-Control no-cache, no-transform — and gates
 *     on an Accept header that must contain BOTH application/json and
 *     text/event-stream (`*` / `*\/*` does NOT satisfy it): 406 with a
 *     -32000 body otherwise. The MODERN (enveloped 2026-07-28) leg is plain
 *     JSON with NO Accept gate.
 *   - Leg discriminator: the presence of
 *     params._meta['io.modelcontextprotocol/protocolVersion'] selects the
 *     modern rules; absent → legacy, no header enforcement.
 *   - `ping` and `initialize` LIVE on the legacy leg; only the modern leg
 *     404s them with -32601. Legacy initialize echoes a supported version
 *     (2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25) and answers
 *     2025-11-25 to anything else — 2026-07-28-sent-raw included.
 *   - Unknown TOOL name → protocol error -32602 `Tool <x> not found` at
 *     HTTP 200; an out-of-schema tool ARGUMENT → an isError result with the
 *     SDK prefix `Input validation error: Invalid arguments for tool <name>:
 *     …` (zod-v4-flavored issue text). App refusals are the BARE sentence.
 *   - No response-header mirroring on any response; notifications answer
 *     202 with NO body and NO content-type; a batch of one is served as a
 *     single non-array response.
 *
 * Every tool refusal is one isError result; existence questions all answer
 * the ONE sentence `… not found (or not visible to you)` — MCP admits
 * nothing anywhere (the 403-oracle is REST's, and only on POST /v1/tasks'
 * top-level project ref). PROVENANCE 'via MCP' signs every write's activity
 * row through the trusted machine-narration seam (model/issues.ts).
 *
 * The TOOLS literal below began as the captured tools/list response and is
 * byte-pinned after every deliberate surface change
 * (convex/tests/mcp.test.ts). It keeps JSON double-quote style on purpose —
 * do not reformat.
 *
 * http.ts calls registerMcpRoutes(http) once at its bolt-on seam and is
 * never edited from here. */

import type { HttpRouter } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { httpAction, internalMutation, internalQuery } from '../_generated/server'
import { hasProjectLevel, profileCanBeAssigned, profileCanSeeProject } from '../lib/access'
import {
  accessFlags,
  asMachineCaller,
  assertOwnUser,
  CALLER_DEACTIVATED,
  CALLER_GONE,
  type Caller,
  childProjectsCore,
  commentOut,
  findIssue,
  findProjectRef,
  issueKey,
  issueOut,
  listCommentsCore,
  listIssuesCore,
  listProjectsCore,
  listUsersCore,
  loadCatalogue,
  mcpProjectOut,
  userJson,
} from '../lib/core'
import { byId } from '../lib/db'
import { vIssuePriority, vIssueStatus } from '../lib/enums'
import { badRequest, forbidden, notFound, type Refusal } from '../lib/functions'
import { mcpResource, mcpResourceMetadata, OAUTH_SCOPES } from '../lib/oauth'
import { type EventReply, WEBHOOK_MAX_TTL_MS } from '../lib/taskEvents'
import { logActivity } from '../model/activity'
import { deleteIssueDeep } from '../model/cascade'
import {
  assertAssignable,
  assertLive,
  assertNoSubtasks,
  assertReporter,
  cleanTitle,
  createIssueCore,
  type IssuePatch,
  metaNeedsSub,
  pairRule,
  REPORTER_IMMUTABLE_SENTENCE,
  SUB_MUST_NAME,
  updateIssueCore,
} from '../model/issues'
import { notifyCommentInsert } from '../model/messages'
import { newUuid, setPlannableHoursCore } from '../model/orgs'
import { authenticateSecret, MCP_AUTH_401, mcpAuth401, sha256hex } from './auth'

/* ------------------------------------------------------------ the 12 tools
 * Titles, descriptions and JSON-Schema literals are wire bytes (LLM-facing
 * prose is behavior-load-bearing), with key order preserved and hashes
 * pinned by the transport tests. */

type SchemaProp = {
  type?: string
  description?: string
  format?: string
  pattern?: string
  enum?: string[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  anyOf?: SchemaProp[]
}

type ToolDef = {
  name: string
  title: string
  description: string
  inputSchema: {
    type: string
    $schema: string
    properties: Record<string, SchemaProp>
    required?: string[]
  }
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_teams',
    title: 'List teams',
    description:
      'Teams in your organization, as id and name. Teams group users for sharing and administration. Projects have no owning team; membership grants access only when a team is explicitly assigned permission.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {},
    },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description:
      'Projects visible to your account. type "meta" projects are products with sub-projects (parent_id); both project types are controlled by a lead and have no owning team. `num` is the durable per-org project number (usable as a ref). Active projects only by default; `archived: true` lists the archived ones instead — an archived project is one that has been put away, keeps everything it had, takes no new tasks, and does not appear in `list_tasks` unless you name it.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        archived: {
          type: 'boolean',
        },
      },
    },
  },
  {
    name: 'list_users',
    title: 'List users',
    description:
      'Users of the organization (use their id as assignee_id, reviewer_id or reporter_id). A roster entry is not proof of assignment eligibility: use `list_project_users` for the destination project and select an assignee or reviewer only from rows with `assignable: true`. `kind` is "person" or "agent" — an agent is a user like you, reachable through the API rather than a login. An assignee must be active and have effective Edit or Lead permission on the destination project; View-only users cannot be assigned work, including when their organization role is "user" or "guest". Reporters may be inactive or viewers when they can see the project. `plannable_hours` is that user\'s own capacity: the whole hours per week they have for planned project work, the work week minus meetings and other overhead (0092). It is what the planner divides by — plan someone at most that many hours in a week, and remember the week is shared across every project they work on, not just yours. It is null for an agent, which has no weekly capacity at all: an agent\'s work is never stretched to fit a calendar and an agent is never over capacity, so do not treat null as zero.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {},
    },
  },
  {
    name: 'list_project_users',
    title: 'List project users',
    description:
      'Users who can see a destination project, for safe reporter_id, assignee_id and reviewer_id mapping. `project` accepts a project number, a key like ENC, or a uuid and must be visible to your account. Every row is a real Qivo profile; `assignable` is true only when that user is active and has effective Edit or Lead permission on the project. Any returned id may be a reporter_id, including an inactive user or viewer, while only rows with `assignable: true` may be an assignee_id or reviewer_id.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        project: {
          type: 'string',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'update_user',
    title: 'Update user',
    description:
      'Set how many hours a week someone can be planned for — a WHOLE number of hours, 1 to 168. Allowed for an organization admin, or a leader of a team that user belongs to — nobody else, your own account included; the database decides, so a refusal here is the same refusal the app would give. An AGENT has no plannable week and cannot be given one (its capacity is unbounded), so this tool applies to people only.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        user_id: {
          type: 'string',
          format: 'uuid',
          pattern:
            '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
        },
        plannable_hours: {
          type: 'integer',
          minimum: 1,
          maximum: 168,
        },
      },
      required: ['user_id', 'plannable_hours'],
    },
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      "Tasks you can see, optionally filtered. `is_group: true` identifies a parent whose stored status is dormant; status filters exclude groups. Every task identifies its reporter (`reporter_id`, `reporter_name`), assignee (`assignee_id`, `assignee_name`) and reviewer (`reviewer_id`, `reviewer_name`); while a task is in `review` with a reviewer set, it is the reviewer's to act on. `project` accepts a project number, a key like ENC, or a uuid; a meta project includes its sub-projects. `search` matches every whitespace-separated fragment across task ID, title and description, case-insensitively and in any order. Active tasks only by default; `archived: true` lists the archived ones instead. Tasks in an ARCHIVED PROJECT are left out altogether unless `project` names that project — archiving a project and archiving a task are separate things, and only the second has a flag here.",
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        project: {
          type: 'string',
        },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'progress', 'review', 'done'],
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
        },
        assignee_id: {
          type: 'string',
          format: 'uuid',
          pattern:
            '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
        },
        search: {
          type: 'string',
        },
        archived: {
          type: 'boolean',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: 'get_task',
    title: 'Get task',
    description:
      "One task with its full description. `is_group: true` identifies a parent whose stored status is dormant. Includes reporter (`reporter_id`, `reporter_name`), assignee (`assignee_id`, `assignee_name`) and reviewer (`reviewer_id`, `reviewer_name`); while a task is in `review` with a reviewer set, it is the reviewer's to act on. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid — task IDs are org-wide, permanent, and survive moves. Resolves archived tasks too (archived_at is non-null on them).",
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: {
          type: 'string',
        },
      },
      required: ['ref'],
    },
  },
  {
    name: 'list_comments',
    title: 'List comments',
    description:
      'The discussion thread on a task, oldest first. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: {
          type: 'string',
        },
      },
      required: ['ref'],
    },
  },
  {
    name: 'add_comment',
    title: 'Add comment',
    description:
      "Comment on a task's discussion thread, as yourself. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid; `body` is markdown. Commenting does not change the task itself.",
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: {
          type: 'string',
        },
        body: {
          type: 'string',
          minLength: 1,
        },
      },
      required: ['ref', 'body'],
    },
  },
  {
    name: 'create_task',
    title: 'Create task',
    description:
      'Create a task in a sub-project you can write to. `project` is a project number, a key like ENC, or a uuid; when it names a type "meta" project, `sub_project` must name one of ITS sub-projects — a task is never created under another project\'s sub-project (create it in the right project, or move it later in the app). Description is markdown. `reporter_id` attributes the task to a real Qivo user who can see the destination project; omit it to use your authenticated user. Null is not accepted, and the reporter cannot be changed after creation. A non-null `assignee_id` must name an active Qivo user with effective Edit or Lead permission on the destination project; use `list_project_users` and select a row with `assignable: true`. `reviewer_id` follows the same rule as `assignee_id` (a row with `assignable: true`); null clears it; a task with subtasks takes no reviewer. A task that enters `review`, created there or moved there, gets its project\'s review time as `remaining_hours` (2 hours unless the project sets another) unless the same call sends a non-null `remaining_hours`; leaving `review` keeps whatever is left.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        project: {
          type: 'string',
        },
        sub_project: {
          type: 'string',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
        },
        description: {
          type: 'string',
        },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'progress', 'review', 'done'],
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
        },
        assignee_id: {
          anyOf: [
            {
              type: 'string',
              format: 'uuid',
              pattern:
                '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            },
            {
              type: 'null',
            },
          ],
        },
        reviewer_id: {
          anyOf: [
            {
              type: 'string',
              format: 'uuid',
              pattern:
                '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            },
            {
              type: 'null',
            },
          ],
        },
        reporter_id: {
          description:
            'Real Qivo user who can see the destination project; omit to use the authenticated caller. Cannot be changed after creation.',
          type: 'string',
          format: 'uuid',
          pattern:
            '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
        },
        due_date: {
          anyOf: [
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            {
              type: 'null',
            },
          ],
        },
        remaining_hours: {
          anyOf: [
            {
              type: 'number',
              minimum: 0,
              maximum: 99999.9,
            },
            {
              type: 'null',
            },
          ],
        },
        archived: {
          type: 'boolean',
        },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'update_task',
    title: 'Update task',
    description:
      "Patch fields on a task in a project you can write to. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid. Omitted fields stay unchanged. A task with subtasks is a group: its stored status is dormant and `status` cannot be changed until its last active subtask is removed. The reporter is set at creation and cannot be changed or cleared. A non-null `assignee_id` must name an active Qivo user with effective Edit or Lead permission on the task's project; use `list_project_users` and select a row with `assignable: true`. `archived: true/false` archives / restores the task (archiving carries its subtasks along; restoring surfaces its parents). `reviewer_id` follows the same rule as `assignee_id` (a row with `assignable: true`); null clears it; a task with subtasks takes no reviewer. A task that enters `review`, created there or moved there, gets its project's review time as `remaining_hours` (2 hours unless the project sets another) unless the same call sends a non-null `remaining_hours`; leaving `review` keeps whatever is left.",
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: {
          type: 'string',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
        },
        description: {
          type: 'string',
        },
        status: {
          type: 'string',
          enum: ['backlog', 'todo', 'progress', 'review', 'done'],
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
        },
        assignee_id: {
          anyOf: [
            {
              type: 'string',
              format: 'uuid',
              pattern:
                '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            },
            {
              type: 'null',
            },
          ],
        },
        reviewer_id: {
          anyOf: [
            {
              type: 'string',
              format: 'uuid',
              pattern:
                '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            },
            {
              type: 'null',
            },
          ],
        },
        due_date: {
          anyOf: [
            {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            {
              type: 'null',
            },
          ],
        },
        remaining_hours: {
          anyOf: [
            {
              type: 'number',
              minimum: 0,
              maximum: 99999.9,
            },
            {
              type: 'null',
            },
          ],
        },
        paused: {
          type: 'boolean',
        },
        archived: {
          type: 'boolean',
        },
      },
      required: ['ref'],
    },
  },
  {
    name: 'delete_task',
    title: 'Delete task',
    description:
      'Delete a task in a project you can write to. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid.',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: {
          type: 'string',
        },
      },
      required: ['ref'],
    },
  },
]

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]))

/* ------------------------------------------------------------ wire shells */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
}

const PROVENANCE = 'via MCP'
const SERVER_INFO = { name: 'qivo', version: '1.0.0' }
const SERVER_META = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
const META_PV = 'io.modelcontextprotocol/protocolVersion'
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities'
const MODERN_VERSION = '2026-07-28'
/* The SDK's legacy revisions: a supported requested version is echoed,
 * anything else answers the latest legacy revision. 2025-03-26 is the one
 * uncaptured member (the shipped revision between the two captured ones). */
const LEGACY_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const LEGACY_FALLBACK = '2025-11-25'
const CACHE_HINTS = { ttlMs: 3600000, cacheScope: 'private' }

const withCors = (extra: Record<string, string>): Headers => new Headers({ ...CORS, ...extra })

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: withCors({ 'Content-Type': 'application/json' }),
  })

/* One legacy SSE frame — exactly `event: message\ndata: <json>\n\n` (the
 * captured frames end in two newline bytes, nothing more). */
const sseRes = (status: number, payload: unknown): Response =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status,
    headers: withCors({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    }),
  })

/* 202 acknowledges a notification: NO body and NO content-type — an
 * empty-string body is a spec violation some clients choke on. */
const ack202 = (): Response => new Response(null, { status: 202, headers: withCors({}) })

const INVALID_MESSAGE = {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'Bad Request: the request body is not a valid JSON-RPC message' },
  id: null,
}

/* The captured -32603 body for a params-less legacy initialize: a
 * pretty-printed zod issue array AS the message string. */
const LEGACY_INIT_NO_PARAMS = JSON.stringify(
  [
    {
      expected: 'object',
      code: 'invalid_type',
      path: ['params'],
      message: 'Invalid input: expected object, received undefined',
    },
  ],
  null,
  2,
)

/* ------------------------------------------- zod-v4-flavored arg validation
 * The deployed surface validated tools/call arguments with zod@4; violations
 * became isError results prefixed `Input validation error: Invalid arguments
 * for tool <name>: `. Only the wrong-primitive-type message is byte-pinned by
 * the capture (`limit: Invalid input: expected number, received string`); the
 * other messages follow zod v4's grammar as closely as hand-rolling allows.
 * Unknown keys are stripped (zod object() default), except immutable reporter
 * updates are refused explicitly. Null satisfies only the
 * anyOf-nullable properties. */

const typeName = (x: unknown): string => {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  if (typeof x === 'number' && Number.isNaN(x)) return 'NaN'
  return typeof x
}

const expectedName = (p: SchemaProp): string =>
  p.type === 'integer' ? 'int' : (p.type ?? 'string')

function checkValue(p: SchemaProp, x: unknown): string | null {
  if (p.anyOf !== undefined) {
    if (x === null) return null // every anyOf in the schema set is <type>|null
    return checkValue(p.anyOf[0], x)
  }
  switch (p.type) {
    case 'string': {
      if (typeof x !== 'string') return `Invalid input: expected string, received ${typeName(x)}`
      if (p.enum !== undefined && !p.enum.includes(x)) {
        return `Invalid option: expected one of ${p.enum.map((e) => `"${e}"`).join('|')}`
      }
      if (p.minLength !== undefined && x.length < p.minLength) {
        return `Too small: expected string to have >=${p.minLength} characters`
      }
      if (p.maxLength !== undefined && x.length > p.maxLength) {
        return `Too big: expected string to have <=${p.maxLength} characters`
      }
      if (p.format === 'uuid') {
        if (p.pattern !== undefined && !new RegExp(p.pattern).test(x)) return 'Invalid UUID'
        return null
      }
      if (p.pattern !== undefined && !new RegExp(p.pattern).test(x)) {
        return `Invalid string: must match pattern /${p.pattern}/`
      }
      return null
    }
    case 'number':
    case 'integer': {
      if (typeof x !== 'number' || Number.isNaN(x)) {
        return `Invalid input: expected number, received ${typeName(x)}`
      }
      if (p.type === 'integer' && !Number.isInteger(x)) {
        return 'Invalid input: expected int, received number'
      }
      if (p.minimum !== undefined && x < p.minimum) {
        return `Too small: expected ${expectedName(p)} to be >=${p.minimum}`
      }
      if (p.maximum !== undefined && x > p.maximum) {
        return `Too big: expected ${expectedName(p)} to be <=${p.maximum}`
      }
      return null
    }
    case 'boolean': {
      if (typeof x !== 'boolean') return `Invalid input: expected boolean, received ${typeName(x)}`
      return null
    }
    default:
      return null
  }
}

/* null = valid; else the joined issue list for the isError text. */
function validateArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  const props = tool.inputSchema.properties
  const required = tool.inputSchema.required ?? []
  const problems: string[] = []
  if (tool.name === 'update_task' && 'reporter_id' in args) {
    problems.push(`reporter_id: ${REPORTER_IMMUTABLE_SENTENCE}`)
  }
  for (const [key, prop] of Object.entries(props)) {
    const value = args[key]
    if (value === undefined) {
      if (required.includes(key)) {
        const base = prop.anyOf !== undefined ? prop.anyOf[0] : prop
        problems.push(`${key}: Invalid input: expected ${expectedName(base)}, received undefined`)
      }
      continue
    }
    const msg = checkValue(prop, value)
    if (msg !== null) problems.push(`${key}: ${msg}`)
  }
  return problems.length > 0 ? problems.join(', ') : null
}

/* Known keys with defined values only — zod strips the rest, and the internal
 * fns' validators refuse unknown keys. */
function pickArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(tool.inputSchema.properties)) {
    if (args[key] !== undefined) out[key] = args[key]
  }
  return out
}

/* --------------------------------------------------- JSON-RPC dispatch core
 * Everything from body parse on, exported so the conformance suite can drive
 * it byte-for-byte without transport plumbing. `runTool` receives validated,
 * stripped arguments; it throws ConvexError refusals (rendered as isError
 * with the bare sentence) — except the auth-race reasons CALLER_GONE /
 * CALLER_DEACTIVATED, which are rethrown for the HTTP action to answer as its
 * own 401 sentence. */

export type McpHeaders = { get(name: string): string | null }
/* Returns the tool result ALREADY 2-space-pretty-printed (the deployed
 * `text()` bytes). Stringification happens INSIDE the internal fn, before the
 * function-boundary crossing: Convex canonically SORTS object keys in values
 * that cross it, and the deployed projections' key order is the wire. */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>

type ToolOutcome =
  | { kind: 'protocol'; error: { code: number; message: string } }
  | { kind: 'result'; result: Record<string, unknown> }

async function callTool(
  params: Record<string, unknown> | undefined,
  run: ToolRunner,
): Promise<ToolOutcome> {
  const name = params?.name
  const tool = typeof name === 'string' ? TOOL_INDEX.get(name) : undefined
  if (tool === undefined) {
    return { kind: 'protocol', error: { code: -32602, message: `Tool ${String(name)} not found` } }
  }
  const raw = params?.arguments
  const args =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const issues = validateArgs(tool, args)
  if (issues !== null) {
    return {
      kind: 'result',
      result: {
        content: [
          {
            type: 'text',
            text: `Input validation error: Invalid arguments for tool ${tool.name}: ${issues}`,
          },
        ],
        isError: true,
      },
    }
  }
  try {
    const text = await run(tool.name, pickArgs(tool, args))
    return { kind: 'result', result: { content: [{ type: 'text', text }] } }
  } catch (e) {
    if (e instanceof ConvexError) {
      const data = e.data as Refusal
      if (data.reason === CALLER_GONE || data.reason === CALLER_DEACTIVATED) throw e
      return {
        kind: 'result',
        result: { content: [{ type: 'text', text: data.message }], isError: true },
      }
    }
    const text = e instanceof Error ? e.message : String(e)
    return { kind: 'result', result: { content: [{ type: 'text', text }], isError: true } }
  }
}

export async function dispatchMcp(a: {
  headers: McpHeaders
  bodyText: string
  runTool: ToolRunner
  runEvent?: (method: string, params: Record<string, unknown>) => Promise<EventReply>
}): Promise<Response> {
  // ---- body shape (before leg selection; plain JSON regardless of Accept)
  let body: unknown
  try {
    body = JSON.parse(a.bodyText)
  } catch {
    return jsonRes(400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    })
  }
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonRes(400, {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: empty JSON-RPC batch' },
        id: null,
      })
    }
    // a batch of ONE is served as a single non-array response (capture 36);
    // real multi-batches are refused — batching left the protocol in 2025-06
    if (body.length > 1) return jsonRes(400, INVALID_MESSAGE)
    body = body[0]
  }
  if (typeof body !== 'object' || body === null) return jsonRes(400, INVALID_MESSAGE)
  const msg = body as Record<string, unknown>
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return jsonRes(400, INVALID_MESSAGE)
  const method = msg.method
  const isNotification = !('id' in msg)
  const id = isNotification ? null : (msg.id as unknown)
  const params =
    typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : undefined
  const rawMeta = params?._meta
  const meta =
    typeof rawMeta === 'object' && rawMeta !== null && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : undefined

  // ---- the leg discriminator: the _meta protocol envelope selects modern
  if (meta === undefined || !(META_PV in meta)) {
    return await legacyLeg({
      headers: a.headers,
      method,
      isNotification,
      id,
      params,
      runTool: a.runTool,
    })
  }
  return await modernLeg({
    headers: a.headers,
    method,
    isNotification,
    id,
    params,
    meta,
    runTool: a.runTool,
    runEvent: a.runEvent,
  })
}

/* ---- the legacy (2025-era) leg: SSE frames behind the strict Accept gate */
async function legacyLeg(a: {
  headers: McpHeaders
  method: string
  isNotification: boolean
  id: unknown
  params: Record<string, unknown> | undefined
  runTool: ToolRunner
}): Promise<Response> {
  const accept = a.headers.get('Accept') ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return jsonRes(406, {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Not Acceptable: Client must accept both application/json and text/event-stream',
      },
      id: null,
    })
  }
  if (a.isNotification) return ack202()
  const { method, id, params } = a
  if (method === 'initialize') {
    if (params === undefined) {
      return sseRes(200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: LEGACY_INIT_NO_PARAMS },
      })
    }
    const requested = params.protocolVersion
    const negotiated =
      typeof requested === 'string' && LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_FALLBACK
    return sseRes(200, {
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      },
      jsonrpc: '2.0',
      id,
    })
  }
  if (method === 'ping') return sseRes(200, { result: {}, jsonrpc: '2.0', id })
  if (method === 'tools/list') return sseRes(200, { result: { tools: TOOLS }, jsonrpc: '2.0', id })
  if (method === 'tools/call') {
    const out = await callTool(params, a.runTool)
    if (out.kind === 'protocol') return sseRes(200, { jsonrpc: '2.0', id, error: out.error })
    return sseRes(200, { result: out.result, jsonrpc: '2.0', id })
  }
  return sseRes(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
}

/* ---- the modern (2026-07-28) leg: plain JSON, mirrored-header enforcement */
async function modernLeg(a: {
  headers: McpHeaders
  method: string
  isNotification: boolean
  id: unknown
  params: Record<string, unknown> | undefined
  meta: Record<string, unknown>
  runTool: ToolRunner
  runEvent?: (method: string, params: Record<string, unknown>) => Promise<EventReply>
}): Promise<Response> {
  const { method, id, params, meta } = a
  const mismatch = (sentence: string, header: string): Response =>
    jsonRes(400, {
      jsonrpc: '2.0',
      error: {
        code: -32020,
        message: `Bad Request: the request headers and body disagree: ${sentence}`,
        data: { mismatch: { header, body: sentence } },
      },
      id,
    })
  const hdrMethod = a.headers.get('Mcp-Method')
  if (hdrMethod === null) {
    return mismatch(
      `the body names method ${method} but the required Mcp-Method header is absent`,
      '(missing)',
    )
  }
  if (hdrMethod !== method) {
    return mismatch(
      `the body names method ${method} but the Mcp-Method header names ${hdrMethod}`,
      hdrMethod,
    )
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : String(params?.name)
    const hdrName = a.headers.get('Mcp-Name')
    if (hdrName === null) {
      return mismatch(
        `the body carries params.name="${name}" but the required Mcp-Name header is absent`,
        '(missing)',
      )
    }
    if (hdrName !== name) {
      return mismatch(
        `the body carries params.name="${name}" but the Mcp-Name header names "${hdrName}"`,
        hdrName,
      )
    }
  }
  if (!(META_CAPS in meta)) {
    return jsonRes(400, {
      jsonrpc: '2.0',
      error: {
        code: -32602,
        message: `Invalid _meta envelope for protocol revision ${MODERN_VERSION}: ${META_CAPS}: missing`,
        data: { envelope: { key: META_CAPS, problem: 'missing' } },
      },
      id,
    })
  }
  const pv = meta[META_PV]
  if (pv !== MODERN_VERSION) {
    return jsonRes(400, {
      jsonrpc: '2.0',
      error: {
        code: -32022,
        message: `Unsupported protocol version: ${String(pv)}`,
        data: { supported: [MODERN_VERSION], requested: pv },
      },
      id,
    })
  }
  if (a.isNotification) return ack202()
  if (method === 'server/discover') {
    return jsonRes(200, {
      result: {
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: { listChanged: true }, events: {} },
        resultType: 'complete',
        ...CACHE_HINTS,
        _meta: SERVER_META,
      },
      jsonrpc: '2.0',
      id,
    })
  }
  if (method === 'tools/list') {
    return jsonRes(200, {
      result: { tools: TOOLS, resultType: 'complete', ...CACHE_HINTS, _meta: SERVER_META },
      jsonrpc: '2.0',
      id,
    })
  }
  if (method === 'tools/call') {
    const out = await callTool(params, a.runTool)
    if (out.kind === 'protocol') return jsonRes(200, { jsonrpc: '2.0', id, error: out.error })
    return jsonRes(200, {
      result: { ...out.result, resultType: 'complete', _meta: SERVER_META },
      jsonrpc: '2.0',
      id,
    })
  }
  if (['events/list', 'events/subscribe', 'events/unsubscribe'].includes(method) && a.runEvent) {
    // MCP permits no expiry only when the client explicitly requests ttlMs: null.
    const eventParams =
      method === 'events/subscribe' && params?.ttlMs === undefined
        ? { ...params, ttlMs: WEBHOOK_MAX_TTL_MS }
        : (params ?? {})
    const reply = await a.runEvent(method, eventParams)
    return jsonRes(200, {
      jsonrpc: '2.0',
      id,
      ...('error' in reply
        ? reply
        : {
            result: { ...reply.result, resultType: 'complete', _meta: SERVER_META },
          }),
    })
  }
  // initialize, ping, logging/setLevel, subscriptions/* — removed or never
  // offered: the revision says 404
  return jsonRes(404, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
}

/* ------------------------------------------------------- shared fn helpers */

async function mustFindIssue(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'issues'>> {
  const issue = await findIssue(ctx, me, ref)
  if (issue === null) throw notFound(`task "${ref}" not found (or not visible to you)`)
  return issue
}

/* The caller's readable/writable predicates over the whole org catalogue —
 * one by_org scan + the access predicates, shared by every scoped read. */
async function catalogueFlags(ctx: QueryCtx, me: Caller) {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat.projects)
  return {
    cat,
    readable: (id: string) => flags.get(id)?.read === true,
    writable: (id: string) => flags.get(id)?.write === true,
  }
}

async function orgNames(ctx: QueryCtx, me: Caller): Promise<Map<string, string>> {
  const rows = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  return new Map(rows.map((p) => [p.id, p.name]))
}

const noWrite = (): ConvexError<Refusal> =>
  forbidden('your account has no write access to that project')

const mustWrite = async (ctx: QueryCtx, me: Caller, projectId: string): Promise<void> => {
  if (!(await hasProjectLevel(ctx, me, projectId, 'user'))) throw noWrite()
}

/* The deployed `text()` body: 2-space pretty JSON, stringified INSIDE the
 * function so the projections' insertion key order survives the Convex value
 * boundary (which sorts object keys). Every fn below returns these bytes. */
const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

/* --------------------------------------------------- the tool internal fns
 * One per tool, `callerId` first (the profile uuid the auth query resolved) —
 * asMachineCaller re-asserts the profile, closing the auth-to-dispatch race.
 * Refusal sentences are MCP's: the uniform not-found, the
 * `your account has no write access to that project` write refusal, the
 * machine wordings of the shared rules. */

export const listTeams = internalQuery({
  args: { callerId: v.string() },
  handler: async (ctx, { callerId }): Promise<string> => {
    const me = await asMachineCaller(ctx, callerId)
    const rows = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect()
    return pretty(
      rows
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((t) => ({ id: t.id, name: t.name })),
    )
  },
})

export const listProjects = internalQuery({
  args: { callerId: v.string(), archived: v.optional(v.boolean()) },
  handler: async (ctx, { callerId, archived }) => {
    const me = await asMachineCaller(ctx, callerId)
    const { readable } = await catalogueFlags(ctx, me)
    return pretty((await listProjectsCore(ctx, me, archived === true, readable)).map(mcpProjectOut))
  },
})

export const listUsers = internalQuery({
  args: { callerId: v.string() },
  handler: async (ctx, { callerId }) => {
    const me = await asMachineCaller(ctx, callerId)
    return pretty((await listUsersCore(ctx, me)).map(userJson))
  },
})

export const listProjectUsers = internalQuery({
  args: { callerId: v.string(), project: v.string() },
  handler: async (ctx, { callerId, project }) => {
    const me = await asMachineCaller(ctx, callerId)
    const { cat, readable } = await catalogueFlags(ctx, me)
    const target = findProjectRef(cat, project)
    if (target === undefined || !readable(target.id)) {
      throw notFound(`project "${project}" not found (or not visible to you)`)
    }
    const out = []
    for (const profile of await listUsersCore(ctx, me)) {
      if (!(await profileCanSeeProject(ctx, profile, target))) continue
      out.push({
        ...userJson(profile),
        assignable: await profileCanBeAssigned(ctx, profile, target),
      })
    }
    return pretty(out)
  },
})

export const updateUser = internalMutation({
  args: { callerId: v.string(), user_id: v.string(), plannable_hours: v.number() },
  handler: async (ctx, { callerId, user_id, plannable_hours }) => {
    const me = await asMachineCaller(ctx, callerId)
    const target = await assertOwnUser(ctx, me, user_id)
    // the core refuses an agent too — this is the readable version, and it
    // keeps the "not found" answer for a uuid outside the organization
    if (target.kind === 'agent') {
      throw badRequest(
        `user "${user_id}" is an agent — an agent has no plannable week, its capacity is unbounded`,
      )
    }
    const fresh = await setPlannableHoursCore(ctx, {
      me,
      profile_id: target.id,
      hours: plannable_hours,
    })
    return pretty(userJson(fresh))
  },
})

export const listIssues = internalQuery({
  args: {
    callerId: v.string(),
    project: v.optional(v.string()),
    status: v.optional(vIssueStatus),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.string()),
    search: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId)
    const { cat, readable } = await catalogueFlags(ctx, me)
    let scope: string[] | null = null
    if (a.project !== undefined && a.project !== '') {
      const p = findProjectRef(cat, a.project)
      if (p === undefined || !readable(p.id)) {
        throw notFound(`project "${a.project}" not found (or not visible to you)`)
      }
      // naming a LIVE meta asks for the project as it stands, so a
      // sub-project archived out of it stays out; naming an archived one
      // asks for it as it was put away, and everything under it comes (0106)
      const kids =
        p.type === 'meta'
          ? await childProjectsCore(ctx, p.id, {
              includeArchived: p.archived_at !== undefined,
              readable,
            })
          : []
      scope = [p.id, ...kids.map((k) => k.id)]
    }
    const rows = await listIssuesCore(
      ctx,
      me,
      {
        scope,
        archived: a.archived === true,
        status: a.status,
        priority: a.priority,
        assignee: a.assignee_id?.toLowerCase(),
        search: a.search,
        stars: false, // MCP has no wildcard — a literal `*` must not widen
        limit: Math.min(a.limit ?? 50, 200),
        offset: 0,
        order: 'key',
      },
      cat,
      readable,
    )
    const names = await orgNames(ctx, me)
    const out = []
    for (const row of rows) {
      out.push(
        await issueOut(ctx, row, {
          surface: 'mcp',
          project: cat.byUuid.get(row.project_id),
          names,
        }),
      )
    }
    return pretty(out)
  },
})

export const getIssue = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, { callerId, ref }) => {
    const me = await asMachineCaller(ctx, callerId)
    const issue = await mustFindIssue(ctx, me, ref)
    return pretty(await issueOut(ctx, issue, { surface: 'mcp' }))
  },
})

export const listComments = internalQuery({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, { callerId, ref }) => {
    const me = await asMachineCaller(ctx, callerId)
    const issue = await mustFindIssue(ctx, me, ref)
    const rows = await listCommentsCore(ctx, issue.id)
    const names = await orgNames(ctx, me)
    const out = []
    for (const c of rows) out.push(await commentOut(ctx, c, { surface: 'mcp', names }))
    return pretty(out)
  },
})

export const addComment = internalMutation({
  args: { callerId: v.string(), ref: v.string(), body: v.string() },
  handler: async (ctx, { callerId, ref, body }) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, callerId)
    const issue = await mustFindIssue(ctx, me, ref)
    const text = body.trim()
    if (text === '') throw badRequest('comment body must not be blank')
    await mustWrite(ctx, me, issue.project_id)
    const id = newUuid() // machine comment ids are server-generated
    await ctx.db.insert('comments', {
      id,
      issue_id: issue.id,
      author: me.id,
      body: text,
      created_at: now,
    })
    const comment = (await byId(ctx, 'comments', id)) as Doc<'comments'>
    // 0114 parity: the author subscribes, mentions fan out, subscribers read
    // 'New comment' — and deliberately NO activity row (the comment IS its
    // own feed entry on the discussion spine)
    await notifyCommentInsert(ctx, { comment, issue, actor: me, now })
    return pretty({ id, task: issueKey(issue.num), created_at: now })
  },
})

export const createIssue = internalMutation({
  args: {
    callerId: v.string(),
    project: v.string(),
    sub_project: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.optional(vIssueStatus),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.union(v.string(), v.null())),
    reviewer_id: v.optional(v.union(v.string(), v.null())),
    reporter_id: v.optional(v.string()),
    due_date: v.optional(v.union(v.string(), v.null())),
    remaining_hours: v.optional(v.union(v.number(), v.null())),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId)
    // declared in the schema so clients can't have it silently stripped;
    // never accepted — and refused FIRST, before any other validation
    if (a.archived !== undefined) {
      throw badRequest('tasks are created active — archive with update_task after creating')
    }
    const title = cleanTitle(a.title)
    const { cat, readable, writable } = await catalogueFlags(ctx, me)
    const p = findProjectRef(cat, a.project)
    if (p === undefined || !readable(p.id)) {
      throw notFound(`project "${a.project}" not found (or not visible to you)`)
    }
    /* Archived projects take no new work (0106). BEFORE the sub-project rules
     * below, or an archived meta would answer "it has no sub-projects yet" —
     * its sub-projects are archived with it (deliberately differs from REST's
     * authorize-before-pair order; both are drive-pinned). */
    assertLive(p)
    let target = p
    if (a.sub_project !== undefined) {
      // an empty ref is a caller bug, not "no sub_project"; an invisible or
      // foreign sub reads exactly like an unknown one (no oracle)
      const sp = a.sub_project.trim() !== '' ? findProjectRef(cat, a.sub_project) : undefined
      if (sp === undefined || !readable(sp.id)) throw badRequest(SUB_MUST_NAME)
      pairRule(p, sp)
      target = sp
    } else if (p.type === 'meta') {
      // an archived sub takes no tasks, so it is not one to suggest, and
      // neither is one this credential could not write to
      const kids = await childProjectsCore(ctx, p.id, { includeArchived: false, readable })
      metaNeedsSub(p, kids, writable)
    }
    // …and again on the resolved target: a sub can be archived on its own
    assertLive(target)
    const assignee = typeof a.assignee_id === 'string' ? a.assignee_id.toLowerCase() : undefined
    const reviewer = typeof a.reviewer_id === 'string' ? a.reviewer_id.toLowerCase() : undefined
    const reporter = typeof a.reporter_id === 'string' ? a.reporter_id.toLowerCase() : undefined
    if (assignee !== undefined) await assertAssignable(ctx, target, assignee)
    if (reviewer !== undefined) await assertAssignable(ctx, target, reviewer, 'reviewer')
    if (reporter !== undefined) await assertReporter(ctx, target, reporter)
    if (!writable(target.id)) throw noWrite()
    const row = await createIssueCore(ctx, {
      me,
      args: {
        id: newUuid(),
        project_id: target.id,
        title,
        description: a.description ?? null,
        status: a.status ?? null,
        priority: a.priority ?? null,
        assignee_id: assignee ?? null,
        reviewer_id: reviewer ?? null,
        reporter_id: reporter,
        due_date: a.due_date ?? null,
        remaining_hours: a.remaining_hours ?? null,
      },
      now,
      machine: { provenance: PROVENANCE },
    })
    return pretty({ id: row.id, key: issueKey(row.num) })
  },
})

export const updateIssue = internalMutation({
  args: {
    callerId: v.string(),
    ref: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(vIssueStatus),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.union(v.string(), v.null())),
    reviewer_id: v.optional(v.union(v.string(), v.null())),
    due_date: v.optional(v.union(v.string(), v.null())),
    remaining_hours: v.optional(v.union(v.number(), v.null())),
    paused: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId)
    const issue = await mustFindIssue(ctx, me, a.ref)
    // collect the whitelist, in the deployed order — `updated` echoes it.
    // Requested keys only: the review time the core sets on entering Review
    // is not echoed.
    const patch: IssuePatch = {}
    const updated: string[] = []
    if (a.title !== undefined) {
      patch.title = cleanTitle(a.title)
      updated.push('title')
    }
    if (a.description !== undefined) {
      patch.description = a.description
      updated.push('description')
    }
    if (a.status !== undefined) {
      patch.status = a.status
      updated.push('status')
    }
    if (a.priority !== undefined) {
      patch.priority = a.priority
      updated.push('priority')
    }
    if (a.assignee_id !== undefined) {
      patch.assignee_id = a.assignee_id === null ? null : a.assignee_id.toLowerCase()
      updated.push('assignee_id')
    }
    if (a.reviewer_id !== undefined) {
      patch.reviewer_id = a.reviewer_id === null ? null : a.reviewer_id.toLowerCase()
      updated.push('reviewer_id')
    }
    if (a.due_date !== undefined) {
      patch.due_date = a.due_date
      updated.push('due_date')
    }
    if (a.remaining_hours !== undefined) {
      patch.remaining_hours = a.remaining_hours
      updated.push('remaining_hours')
    }
    if (a.paused !== undefined) {
      patch.paused = a.paused
      updated.push('paused')
    }
    // the readable pre-check sentences fire before the core's rule backstop
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project === null) throw notFound('task not found')
    if (typeof patch.assignee_id === 'string')
      await assertAssignable(ctx, project, patch.assignee_id)
    if (typeof patch.reviewer_id === 'string')
      await assertAssignable(ctx, project, patch.reviewer_id, 'reviewer')
    // archived is a boolean on the surface, a timestamp underneath; matching
    // the current state is a no-op slot, not a toggle
    const toggles = a.archived !== undefined && a.archived !== (issue.archived_at !== undefined)
    if (toggles) updated.push('archived_at')
    if (updated.length === 0) {
      if (a.archived !== undefined)
        return pretty({ id: issue.id, key: issueKey(issue.num), updated: [] })
      throw badRequest('no fields to update')
    }
    // machine pre-check: fires on ANY non-null value, not only on change —
    // and BEFORE the write gate, as deployed (assertNoSubtasks ran ahead of
    // the RLS-refused UPDATE)
    if (patch.remaining_hours != null) await assertNoSubtasks(ctx, issue.id)
    await mustWrite(ctx, me, issue.project_id)
    // ONE row write, ONE notify fan-out (the Archived/Restored line rides
    // with the field lines), ONE activity row + the cascade — the trusted
    // machine-narration seam folds the toggle into the same patch
    await updateIssueCore(ctx, {
      me,
      issue,
      patch,
      now,
      machine: { provenance: PROVENANCE, archive: a.archived },
    })
    return pretty({ id: issue.id, key: issueKey(issue.num), updated })
  },
})

export const deleteIssue = internalMutation({
  args: { callerId: v.string(), ref: v.string() },
  handler: async (ctx, { callerId, ref }) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, callerId)
    const issue = await mustFindIssue(ctx, me, ref)
    await mustWrite(ctx, me, issue.project_id)
    await deleteIssueDeep(ctx, { issue, actor: me, now })
    await logActivity(ctx, {
      org_id: issue.org_id,
      actor_id: me.id,
      verb: 'deleted',
      target_type: 'issue',
      target_id: issue.id,
      label: issue.title,
      detail: PROVENANCE,
      project_id: issue.project_id,
      ts: now,
    })
    return pretty({ deleted: true, key: issueKey(issue.num) })
  },
})

/* --------------------------------------------------------- tool dispatcher
 * Validated, stripped wire arguments → the internal fn for the tool. The
 * casts are honest: validateArgs/pickArgs already enforced the shapes. */

async function runTool(
  ctx: ActionCtx,
  callerId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'list_teams':
      return await ctx.runQuery(internal.machine.mcp.listTeams, { callerId })
    case 'list_projects':
      return await ctx.runQuery(internal.machine.mcp.listProjects, {
        callerId,
        ...(args as { archived?: boolean }),
      })
    case 'list_users':
      return await ctx.runQuery(internal.machine.mcp.listUsers, { callerId })
    case 'list_project_users':
      return await ctx.runQuery(internal.machine.mcp.listProjectUsers, {
        callerId,
        ...(args as { project: string }),
      })
    case 'update_user':
      return await ctx.runMutation(internal.machine.mcp.updateUser, {
        callerId,
        ...(args as { user_id: string; plannable_hours: number }),
      })
    case 'list_tasks':
      return await ctx.runQuery(internal.machine.mcp.listIssues, {
        callerId,
        ...(args as {
          project?: string
          status?: Doc<'issues'>['status']
          priority?: Doc<'issues'>['priority']
          assignee_id?: string
          search?: string
          archived?: boolean
          limit?: number
        }),
      })
    case 'get_task':
      return await ctx.runQuery(internal.machine.mcp.getIssue, {
        callerId,
        ...(args as { ref: string }),
      })
    case 'list_comments':
      return await ctx.runQuery(internal.machine.mcp.listComments, {
        callerId,
        ...(args as { ref: string }),
      })
    case 'add_comment':
      return await ctx.runMutation(internal.machine.mcp.addComment, {
        callerId,
        ...(args as { ref: string; body: string }),
      })
    case 'create_task':
      return await ctx.runMutation(internal.machine.mcp.createIssue, {
        callerId,
        ...(args as {
          project: string
          sub_project?: string
          title: string
          description?: string
          status?: Doc<'issues'>['status']
          priority?: Doc<'issues'>['priority']
          assignee_id?: string | null
          reviewer_id?: string | null
          reporter_id?: string
          due_date?: string | null
          remaining_hours?: number | null
          archived?: boolean
        }),
      })
    case 'update_task':
      return await ctx.runMutation(internal.machine.mcp.updateIssue, {
        callerId,
        ...(args as {
          ref: string
          title?: string
          description?: string
          status?: Doc<'issues'>['status']
          priority?: Doc<'issues'>['priority']
          assignee_id?: string | null
          reviewer_id?: string | null
          due_date?: string | null
          remaining_hours?: number | null
          paused?: boolean
          archived?: boolean
        }),
      })
    case 'delete_task':
      return await ctx.runMutation(internal.machine.mcp.deleteIssue, {
        callerId,
        ...(args as { ref: string }),
      })
    default:
      // unreachable: callTool resolves names against TOOL_INDEX first
      throw new Error(`unknown tool ${name}`)
  }
}

/* ------------------------------------------------------------ the transport */

const unauthorized = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: withCors({
      'Content-Type': 'application/json',
      // Clients use this scope set for their first authorization request.
      // Planning needs writes; consent can still narrow the grant to reading.
      'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceMetadata()}", scope="${OAUTH_SCOPES.join(' ')}"`,
    }),
  })

const rateLimited = (): Response =>
  new Response(JSON.stringify({ error: 'Too many requests. Try again in 60 seconds.' }), {
    status: 429,
    headers: withCors({ 'Content-Type': 'application/json', 'Retry-After': '60' }),
  })

const OAUTH_WRITE_TOOLS = new Set([
  'update_user',
  'add_comment',
  'create_task',
  'update_task',
  'delete_task',
])
const scopeChallenge = (bodyText: string, scopes: string[]): Response | null => {
  let needsWrite = false
  try {
    const parsed: unknown = JSON.parse(bodyText)
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    needsWrite = messages.some((message) => {
      if (!message || typeof message !== 'object') return false
      const rpc = message as { method?: unknown; params?: { name?: unknown } }
      return (
        rpc.method === 'tools/call' &&
        typeof rpc.params?.name === 'string' &&
        OAUTH_WRITE_TOOLS.has(rpc.params.name)
      )
    })
  } catch {
    return null
  } // The dispatcher owns parse errors.
  if (scopes.includes('qivo:read') && (!needsWrite || scopes.includes('qivo:write'))) return null
  const required = needsWrite ? 'qivo:read qivo:write' : 'qivo:read'
  return new Response(
    JSON.stringify({
      error: 'insufficient_scope',
      error_description: `This connection requires ${required}.`,
    }),
    {
      status: 403,
      headers: withCors({
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer error="insufficient_scope", resource_metadata="${mcpResourceMetadata()}", scope="${required}"`,
      }),
    },
  )
}

/* 405 for every non-POST verb, BEFORE any auth or work (an old client
 * probing for the removed GET stream must not cost a function call). */
const notAllowed = httpAction(async () => {
  return new Response(JSON.stringify({ error: 'stateless MCP server — POST JSON-RPC only' }), {
    status: 405,
    headers: withCors({ Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' }),
  })
})

const preflight = httpAction(async () => {
  return new Response('ok', {
    status: 200,
    headers: withCors({ 'Content-Type': 'text/plain;charset=UTF-8' }),
  })
})

const mcpPost = httpAction(async (ctx, request) => {
  if (!(await ctx.runMutation(internal.billingMetering.ingress, {}))) return rateLimited()
  // Bearer only — no X-Api-Key on MCP; the 'Bearer ' prefix match is
  // case-sensitive with one space (a lowercase `bearer` falls to `missing`)
  const auth = request.headers.get('Authorization') ?? ''
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (secret.startsWith('qvo_')) {
    const tokenHash = await sha256hex(secret.slice(4))
    const resource = mcpResource()
    const credential = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
      tokenHash,
      resource,
    })
    if (
      !credential ||
      !(await ctx.runMutation(internal.oauthConnections.touch, { id: credential.connectionId }))
    )
      return unauthorized('OAuth connection is invalid, expired or disconnected')
    if (
      !(await ctx.runMutation(internal.billingMetering.oauthCall, {
        connection_id: credential.connectionId,
      }))
    )
      return rateLimited()
    const bodyText = await request.text()
    const challenge = scopeChallenge(bodyText, credential.scopes)
    if (challenge) return challenge
    try {
      return await dispatchMcp({
        headers: request.headers,
        bodyText,
        runEvent: async (method, params) => {
          const live = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
            tokenHash,
            resource,
          })
          if (!live?.scopes.includes('qivo:read'))
            return {
              error: {
                code: -32012,
                message: 'OAuth connection is invalid, expired or disconnected',
              },
            }
          return ctx.runAction(internal.webhookActions.manage, {
            owner: {
              profile_id: live.profileId,
              credential_table: 'oauth_connections',
              credential_id: live.connectionId,
              credential_row_id: live.connectionRowId,
            },
            method,
            params_json: JSON.stringify(params),
          })
        },
        runTool: async (name, args) => {
          // Both protocol versions enter this same gate. Recheck the live grant
          // on every tool in a batch, alongside the existing permission checks.
          const live = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
            tokenHash,
            resource,
          })
          if (!live) throw forbidden('OAuth connection is invalid, expired or disconnected')
          const write = OAUTH_WRITE_TOOLS.has(name)
          const scope = write ? 'qivo:write' : 'qivo:read'
          if (!live.scopes.includes(scope))
            throw forbidden(`This connection does not have the ${scope} scope.`)
          return runTool(ctx, live.profileId, name, args)
        },
      })
    } catch (error) {
      if (
        error instanceof ConvexError &&
        [CALLER_GONE, CALLER_DEACTIVATED].includes((error.data as Refusal).reason || '')
      )
        return unauthorized('OAuth connection is invalid, expired or disconnected')
      return jsonRes(500, { error: String(error) })
    }
  }
  const res = await authenticateSecret(ctx, secret, { person: true })
  // `=== false` (not `!res.ok`): the root tsconfig typechecks this file via
  // _generated/api.d.ts under strict:false, where truthiness narrowing of the
  // discriminant does not apply
  if (res.ok === false) return unauthorized(mcpAuth401(res))
  const cred = res.cred
  // per-call last_used_at stamp — every authenticated request, before any
  // routing or work, even ones that then answer 400
  const allowed = await ctx.runMutation(internal.machine.auth.touchCredential, {
    table: cred.isAgent ? 'agent_keys' : 'mcp_tokens',
    tokenId: cred.tokenId,
    rowId: cred.rowId,
    profileId: cred.profileId,
    now: new Date().toISOString(),
  })
  if (allowed === null) return unauthorized('Credential is no longer valid')
  if (!allowed) return rateLimited()
  const bodyText = await (request as unknown as { text(): Promise<string> }).text()
  try {
    return await dispatchMcp({
      headers: request.headers,
      bodyText,
      runTool: (name, args) => runTool(ctx, cred.profileId, name, args),
      runEvent: (method, params) =>
        ctx.runAction(internal.webhookActions.manage, {
          owner: {
            profile_id: cred.profileId,
            credential_table: cred.isAgent ? 'agent_keys' : 'mcp_tokens',
            credential_id: cred.tokenId,
            credential_row_id: cred.rowId,
          },
          method,
          params_json: JSON.stringify(params),
        }),
    })
  } catch (e) {
    // the auth-to-dispatch race: the profile flipped between lookup and
    // dispatch — answer the same 401 the auth would have given
    if (e instanceof ConvexError) {
      const reason = (e.data as Refusal).reason
      if (reason === CALLER_GONE || reason === CALLER_DEACTIVATED) {
        return unauthorized(cred.isAgent ? MCP_AUTH_401.agent : MCP_AUTH_401.person)
      }
    }
    return jsonRes(500, { error: String(e) })
  }
})

export function registerMcpRoutes(http: HttpRouter): void {
  http.route({ path: '/mcp', method: 'POST', handler: mcpPost })
  http.route({ path: '/mcp', method: 'OPTIONS', handler: preflight })
  // explicit per-verb 405s with the deployed body — Convex's own
  // method-mismatch answer has the wrong shape (HEAD stays unregistrable,
  // accepted edge)
  http.route({ path: '/mcp', method: 'GET', handler: notAllowed })
  http.route({ path: '/mcp', method: 'DELETE', handler: notAllowed })
  http.route({ path: '/mcp', method: 'PUT', handler: notAllowed })
  http.route({ path: '/mcp', method: 'PATCH', handler: notAllowed })
}
