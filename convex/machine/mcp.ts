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
 * the ONE sentence `… not found (or not visible to you)`, so MCP, like REST,
 * admits nothing about what the caller cannot read. PROVENANCE 'via MCP' signs every write's activity
 * row through the trusted machine-narration seam (model/issues.ts).
 *
 * Layering: this file owns the MCP grammar and the transport. TOOLS below is
 * the registry (machine/registry.ts). Each tool is declared once with its
 * required read/write `access` flag, its wire `def` and the `run` that calls
 * its ONE internal fn. tools/list answers the defs; the OAuth scope checks
 * derive from the flag (a write tool needs qivo:write). The defs began as the
 * captured tools/list response and are byte-pinned after every deliberate
 * surface change (convex/tests/mcp.test.ts), so keep their key order and text.
 *
 * http.ts calls registerMcpRoutes(http) once at its bolt-on seam and is
 * never edited from here. */

import type { HttpRouter } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx, QueryCtx } from '../_generated/server'
import { httpAction, internalMutation, internalQuery } from '../_generated/server'
import { hasProjectLevel } from '../lib/access'
import { archiveCursorText } from '../lib/archivedTasks'
import {
  accessFlags,
  applyTaskUpdate,
  asMachineCaller,
  assertOwnUser,
  CALLER_DEACTIVATED,
  CALLER_GONE,
  type Caller,
  COMMENT_PAGE_MAX,
  childProjectsCore,
  commentOut,
  destinationOf,
  findIssue,
  findProjectRef,
  issueKey,
  listActiveIssuesCore,
  listArchivedIssuesCore,
  listCommentsCore,
  listProjectsCore,
  listProjectUsersCore,
  listUsersCore,
  loadCatalogue,
  meCore,
  projectJson,
  taskListRequest,
  taskOut,
  userJson,
} from '../lib/core'
import { byId } from '../lib/db'
import {
  type CredentialAccess,
  vCredentialAccess,
  vIssuePriority,
  vIssueStatus,
} from '../lib/enums'
import { badRequest, forbidden, notFound, type Refusal } from '../lib/functions'
import { mcpResource, mcpResourceMetadata, OAUTH_SCOPES } from '../lib/oauth'
import {
  type EventOwner,
  type EventReply,
  vEventOwner,
  WEBHOOK_MAX_TTL_MS,
} from '../lib/taskEvents'
import { TEXT_MAX } from '../lib/textLimits'
import { COMMENT_MAX } from '../model/commentCounts'
import { postComment } from '../model/comments'
import {
  assertAssignable,
  assertAssignableChange,
  assertLive,
  assertNoGroupDates,
  assertNoSubtasks,
  assertReporter,
  cleanTitle,
  createIssueCore,
  deleteIssueCore,
  type IssuePatch,
  linkAccess,
  metaNeedsSub,
  pairRule,
  REPORTER_IMMUTABLE_SENTENCE,
  SUB_MUST_NAME,
} from '../model/issues'
import {
  assertLabelCreator,
  assertLabelManager,
  createLabelCore,
  findLabel,
  labelChanges,
  labelJson,
  listLabelsCore,
  updateLabelCore,
} from '../model/labels'
import {
  addLinkCore,
  removeLinkCore,
  storedLink,
  type TaskLinkKind,
  vTaskLinkKind,
} from '../model/links'
import { newUuid, setPlannableHoursCore } from '../model/orgs'
import { teamsJson } from '../model/teams'
import { authenticateSecret, MCP_AUTH_401, mcpAuth401, sha256hex } from './auth'
import { DISCUSSION_TOOLS } from './discussion'
import { PROJECT_TOOLS } from './projects'
import { RECORD_TOOLS } from './records'
import { type MachineEntry, needsWrite, type Principal, runEntry } from './registry'
import {
  internalError,
  MCP_NO_WRITE,
  MCP_PROVENANCE as PROVENANCE,
  pretty,
  readBody,
  withIgnored,
} from './shared'
import { TEAM_TOOLS } from './teams'

/* --------------------------------------------------------------- the tools
 * Each tool is ONE registry entry (machine/registry.ts): its required
 * read/write `access` flag, its `def` and the `run` that calls its internal
 * fn. tools/list answers the defs in this order. Titles, descriptions and
 * JSON-Schema literals are wire bytes (LLM-facing prose is
 * behavior-load-bearing), with key order preserved and hashes pinned by the
 * transport tests. `run` receives validated, stripped wire arguments, so its
 * casts are honest. validateArgs and pickArgs already enforced the shapes. */

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
  items?: SchemaProp
  minItems?: number
  maxItems?: number
  anyOf?: SchemaProp[]
  properties?: Record<string, SchemaProp>
  required?: string[]
}

/* The uuid pattern every uuid property of the tool schemas carries. */
const UUID_PATTERN =
  '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'

/* A task date or week start, or null to clear it. */
const NULLABLE_DATE: SchemaProp = {
  anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }],
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

/** The principal, the credential row that authenticated the request (for
 *  get_me), the arguments a tool's `run` receives and the names of the
 *  arguments its schema does not know, which were dropped. */
type ToolInput = Principal & {
  credential: EventOwner
  args: Record<string, unknown>
  ignored: string[]
}

/** One MCP tool. `run` answers the already pretty-printed result text. */
type McpTool = MachineEntry<ToolInput, string> & { def: ToolDef }

export const TOOLS: McpTool[] = [
  {
    access: 'read',
    def: {
      name: 'get_me',
      title: 'Who am I',
      description:
        "Your own user, your organization's settings (calendar, upload limit, who may create projects), whether billing has paused changes, and this credential's kind and access (`read` or `write`). Call it first to learn who you act as and whether you can make changes.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {},
      },
    },
    run: (r, { callerId, access, credential }) =>
      r.runQuery(internal.machine.mcp.getMe, { callerId, access, credential }),
  },
  {
    access: 'read',
    def: {
      name: 'list_teams',
      title: 'List teams',
      description:
        'Teams in your organization, each with `id`, `name` and its `members` (`id`, `name`, `leader`). Teams group users for sharing and administration. Projects have no owning team; membership grants access only when a team is explicitly assigned permission.',
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {},
      },
    },
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.mcp.listTeams, { callerId, access }),
  },
  {
    access: 'read',
    def: {
      name: 'list_projects',
      title: 'List projects',
      description:
        'Projects visible to your account. type "meta" projects are products with sub-projects (parent_id); both project types are controlled by a lead and have no owning team. `num` is the durable per-org project number (usable as a ref). `access.write` says whether you may create and change tasks in that project. Active projects only by default; `archived: true` lists the archived ones instead — an archived project is one that has been put away, keeps everything it had, takes no new tasks, and does not appear in `list_tasks` unless you name it.',
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
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.mcp.listProjects, {
        callerId,
        access,
        ...(args as { archived?: boolean }),
      }),
  },
  {
    access: 'read',
    def: {
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
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.mcp.listUsers, { callerId, access }),
  },
  {
    access: 'read',
    def: {
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
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.mcp.listProjectUsers, {
        callerId,
        access,
        ...(args as { project: string }),
      }),
  },
  {
    access: 'write',
    def: {
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
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.mcp.updateUser, {
        callerId,
        access,
        ...(args as { user_id: string; plannable_hours: number }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'list_tasks',
      title: 'List tasks',
      description:
        "Tasks you can see, optionally filtered, oldest first by creation. `is_group: true` identifies a parent whose stored status is dormant; status filters exclude groups. Every task identifies its reporter (`reporter_id`, `reporter_name`), assignee (`assignee_id`, `assignee_name`) and reviewer (`reviewer_id`, `reviewer_name`); while a task is in `review` with a reviewer set, it is the reviewer's to act on, and `owner_id` names whose work it is. `project` accepts a project number, a key like ENC, or a uuid; a meta project includes its sub-projects. `status` takes one status or a list. `search` matches every whitespace-separated fragment across task ID, title, description, status, priority, assignee name and label names, case-insensitively and in any order. `offset` skips that many results. Active tasks only by default. `archived: true` lists archived tasks instead and needs `project`, which then includes all its sub-projects you can read, archived ones too; to cover them all, name each top-level project that `list_projects` returns with and without `archived: true`. That answer is `{next_cursor, tasks}`, most recently archived first; pass `next_cursor` back as `cursor` until it is null, because a page may hold fewer than `limit` tasks, even none. Tasks in an ARCHIVED PROJECT are left out of active lists unless `project` names that project. Archiving a project and archiving a task are separate things, and only the second has a flag here.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          project: {
            type: 'string',
          },
          status: {
            anyOf: [
              {
                type: 'string',
                enum: ['backlog', 'todo', 'progress', 'review', 'done'],
              },
              {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['backlog', 'todo', 'progress', 'review', 'done'],
                },
                minItems: 1,
              },
            ],
          },
          priority: {
            type: 'string',
            enum: ['urgent', 'high', 'medium', 'low'],
          },
          assignee_id: {
            type: 'string',
            format: 'uuid',
            pattern: UUID_PATTERN,
          },
          owner_id: {
            type: 'string',
            format: 'uuid',
            pattern: UUID_PATTERN,
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
          offset: {
            type: 'integer',
            minimum: 0,
          },
          cursor: {
            type: 'string',
            minLength: 1,
          },
        },
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.mcp.listIssues, {
        callerId,
        access,
        ...(args as {
          project?: string
          status?: Doc<'issues'>['status'] | Doc<'issues'>['status'][]
          priority?: Doc<'issues'>['priority']
          assignee_id?: string
          owner_id?: string
          search?: string
          archived?: boolean
          limit?: number
          offset?: number
          cursor?: string
        }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'get_task',
      title: 'Get task',
      description:
        "One task with its full description, labels, subtasks, links and attachments (with 10-minute download links), and for a group (`is_group: true`, whose stored status is dormant) `group_remaining_hours`. Includes reporter (`reporter_id`, `reporter_name`), assignee (`assignee_id`, `assignee_name`) and reviewer (`reviewer_id`, `reviewer_name`); while a task is in `review` with a reviewer set, it is the reviewer's to act on, and `owner_id` names whose work it is. `parent_id` is null when the parent is hidden from you (`has_hidden_parent: true`). `ref` is a task ID like QN-482 (bare 482 works too) or a uuid. Task IDs are org-wide, permanent, and survive moves. Resolves archived tasks too (archived_at is non-null on them).",
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
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.mcp.getIssue, { callerId, access, ...(args as { ref: string }) }),
  },
  {
    access: 'read',
    def: {
      name: 'list_comments',
      title: 'List comments',
      description: `The newest comments on a task, oldest first. \`ref\` is a task ID like QN-482 (bare 482 works too) or a uuid. \`limit\` caps how many (${COMMENT_PAGE_MAX} by default and at most), and long comments can make a page shorter. To read further back, pass the first comment's \`id\` as \`before\`. An empty list means there are no earlier comments.`,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: COMMENT_PAGE_MAX,
          },
          before: {
            type: 'string',
          },
        },
        required: ['ref'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.mcp.listComments, {
        callerId,
        access,
        ...(args as { ref: string; limit?: number; before?: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'add_comment',
      title: 'Add comment',
      description: `Comment on a task's discussion thread, as yourself. \`ref\` is a task ID like QN-482 (bare 482 works too) or a uuid; \`body\` is markdown. Commenting does not change the task itself. A task holds at most ${COMMENT_MAX} comments; past that, start a new task.`,
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
            maxLength: TEXT_MAX,
          },
        },
        required: ['ref', 'body'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.mcp.addComment, {
        callerId,
        access,
        ...(args as { ref: string; body: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'create_task',
      title: 'Create task',
      description:
        'Create a task in a sub-project you can write to. `project` is a project number, a key like ENC, or a uuid; when it names a type "meta" project, `sub_project` must name one of ITS sub-projects. A task is never created under another project\'s sub-project (create it in the right project, or move it later with update_task). `parent` (a task ref) makes it a subtask of that task; the parent must be in the same top-level project, in any of its sub-projects. `start_week` and `end_week` plan it as week starts in YYYY-MM-DD, both or neither. Description is markdown. `reporter_id` attributes the task to a real Qivo user who can see the destination project; omit it to use your authenticated user. Null is not accepted, and the reporter cannot be changed after creation. A non-null `assignee_id` must name an active Qivo user with effective Edit or Lead permission on the destination project; use `list_project_users` and select a row with `assignable: true`. `reviewer_id` follows the same rule as `assignee_id` (a row with `assignable: true`); null clears it; a task with subtasks takes no reviewer. A task that enters `review`, created there or moved there, gets its project\'s review time as `remaining_hours` (2 hours unless the project sets another) unless the same call sends a non-null `remaining_hours`; leaving `review` keeps whatever is left. Arguments this tool does not know are listed in `ignored_arguments`.',
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
          parent: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
          },
          description: {
            type: 'string',
            maxLength: TEXT_MAX,
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
          start_week: NULLABLE_DATE,
          end_week: NULLABLE_DATE,
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
        required: ['project', 'title'],
      },
    },
    run: async (r, { callerId, access, args, ignored }) =>
      withIgnored(
        await r.runMutation(internal.machine.mcp.createIssue, {
          callerId,
          access,
          ...(args as {
            project: string
            sub_project?: string
            parent?: string | null
            title: string
            description?: string
            status?: Doc<'issues'>['status']
            priority?: Doc<'issues'>['priority']
            assignee_id?: string | null
            reviewer_id?: string | null
            reporter_id?: string
            start_week?: string | null
            end_week?: string | null
            due_date?: string | null
            remaining_hours?: number | null
            paused?: boolean
            archived?: boolean
          }),
        }),
        ignored,
      ),
  },
  {
    access: 'write',
    def: {
      name: 'update_task',
      title: 'Update task',
      description:
        "Patch fields on a task in a project you can write to. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid. Omitted fields stay unchanged. A task with subtasks is a group. Its stored status and dates are dormant, and `status`, `start_week` and `end_week` cannot be changed until its last active subtask is removed. The reporter is set at creation and cannot be changed or cleared. A non-null `assignee_id` must name an active Qivo user with effective Edit or Lead permission on the task's project; use `list_project_users` and select a row with `assignable: true`. `archived: true/false` archives / restores the task (archiving carries its subtasks along; restoring surfaces its parents); `archive_reason` with `archived: true` posts the reason as a comment. `reviewer_id` follows the same rule as `assignee_id` (a row with `assignable: true`); null clears it; a task with subtasks takes no reviewer. `project` and `sub_project` move the task, named as in create_task; a move to another top-level project carries its subtasks along, and a subtask moved there must leave its parent in the same call (`parent` null, or a task in that project). `parent` (a task ref) makes it a subtask, null detaches it. `add_labels` and `remove_labels` take label ids or names. A task that enters `review`, created there or moved there, gets its project's review time as `remaining_hours` (2 hours unless the project sets another) unless the same call sends a non-null `remaining_hours`; leaving `review` keeps whatever is left. Arguments this tool does not know are listed in `ignored_arguments`.",
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
            maxLength: TEXT_MAX,
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
          start_week: NULLABLE_DATE,
          end_week: NULLABLE_DATE,
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
          archive_reason: {
            type: 'string',
            maxLength: TEXT_MAX,
          },
          project: {
            type: 'string',
          },
          sub_project: {
            type: 'string',
          },
          parent: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          add_labels: {
            type: 'array',
            items: { type: 'string' },
          },
          remove_labels: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['ref'],
      },
    },
    run: async (r, { callerId, access, args, ignored }) =>
      withIgnored(
        await r.runMutation(internal.machine.mcp.updateIssue, {
          callerId,
          access,
          ...(args as {
            ref: string
            title?: string
            description?: string
            status?: Doc<'issues'>['status']
            priority?: Doc<'issues'>['priority']
            assignee_id?: string | null
            reviewer_id?: string | null
            due_date?: string | null
            start_week?: string | null
            end_week?: string | null
            remaining_hours?: number | null
            paused?: boolean
            archived?: boolean
            archive_reason?: string
            project?: string
            sub_project?: string
            parent?: string | null
            add_labels?: string[]
            remove_labels?: string[]
          }),
        }),
        ignored,
      ),
  },
  {
    access: 'write',
    def: {
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
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.mcp.deleteIssue, {
        callerId,
        access,
        ...(args as { ref: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'set_task_link',
      title: 'Link tasks',
      description:
        'Link two tasks, or with `linked: false` remove the link. `kind` is as seen from `ref`: `blocks`, `blocked_by` or `relates`. Two tasks share at most one link. Needs sight of both tasks and Edit on either; get_task lists the links.',
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          other: {
            type: 'string',
          },
          kind: {
            type: 'string',
            enum: ['blocks', 'blocked_by', 'relates'],
          },
          linked: {
            type: 'boolean',
          },
        },
        required: ['ref', 'other', 'kind', 'linked'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.mcp.setTaskLink, {
        callerId,
        access,
        ...(args as { ref: string; other: string; kind: TaskLinkKind; linked: boolean }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'list_labels',
      title: 'List labels',
      description:
        "Your organization's labels, as id, name and color. update_task adds and removes them by id or name.",
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {},
      },
    },
    run: (r, { callerId, access }) =>
      r.runQuery(internal.machine.mcp.listLabels, { callerId, access }),
  },
  {
    access: 'write',
    def: {
      name: 'set_label',
      title: 'Set label',
      description:
        'Without `label`, create a label from `name` and `color` (#rrggbb); that needs Edit access to a top-level project. With `label` (an id or name), rename or recolor it; only organization admins may.',
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          label: {
            type: 'string',
          },
          name: {
            type: 'string',
          },
          color: {
            type: 'string',
          },
        },
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.mcp.setLabel, {
        callerId,
        access,
        ...(args as { label?: string; name?: string; color?: string }),
      }),
  },
  ...RECORD_TOOLS,
  ...DISCUSSION_TOOLS,
  ...PROJECT_TOOLS,
  ...TEAM_TOOLS,
]

const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => t.def)
const TOOL_INDEX = new Map(TOOLS.map((t) => [t.def.name, t]))

/* ------------------------------------------------------------ wire shells */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
}

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

/* The 413 body for a request over BODY_MAX_BYTES (shared.ts readBody), in
 * INVALID_MESSAGE's form. */
const TOO_LARGE = {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'Bad Request: the request body is too large' },
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
 * anyOf-nullable properties. Unlike zod, a string with an unpaired surrogate
 * is refused, because Convex cannot pass it on to the tool's function. */

const typeName = (x: unknown): string => {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  if (typeof x === 'number' && Number.isNaN(x)) return 'NaN'
  return typeof x
}

const expectedName = (p: SchemaProp): string =>
  p.type === 'integer' ? 'int' : (p.type ?? 'string')

/* Whether `x` has the JSON type `p` names, before any narrower check. */
function hasType(p: SchemaProp, x: unknown): boolean {
  switch (p.type) {
    case 'null':
      return x === null
    case 'array':
      return Array.isArray(x)
    case 'integer':
      return typeof x === 'number'
    default:
      return typeof x === p.type
  }
}

/* Arguments whose minLength and maxLength count code points, as the server's
 * rules for them do (cleanTitle, NAME_MAX), so most single emoji count once.
 * Every other argument counts UTF-16 code units, the unit of the long text
 * caps (TEXT_MAX) and of zod's string checks. */
const CODE_POINT_ARGS: ReadonlySet<string> = new Set(['title', 'name'])

/* The issue for a string holding an unpaired surrogate, which is not text.
 * In a /u pattern a whole pair reads as one code point, so only half a pair
 * matches the Surrogate category. */
const UNPAIRED_SURROGATE = 'Invalid string: has an unpaired surrogate, which UTF-8 cannot encode'
const LONE_SURROGATE = /\p{Surrogate}/u

/* `codePoints` says how a string's length counts (CODE_POINT_ARGS). */
function checkValue(p: SchemaProp, x: unknown, codePoints = false): string | null {
  if (p.anyOf !== undefined) {
    // the alternative of the value's own type decides, else the first one
    const alternative = p.anyOf.find((option) => hasType(option, x)) ?? p.anyOf[0]
    return alternative.type === 'null' && x === null ? null : checkValue(alternative, x, codePoints)
  }
  switch (p.type) {
    case 'string': {
      if (typeof x !== 'string') return `Invalid input: expected string, received ${typeName(x)}`
      // a JSON escape such as \ud800 can leave half a surrogate pair, which
      // Convex cannot pass to a function, so the call would fail later
      if (LONE_SURROGATE.test(x)) return UNPAIRED_SURROGATE
      if (p.enum !== undefined && !p.enum.includes(x)) {
        return `Invalid option: expected one of ${p.enum.map((e) => `"${e}"`).join('|')}`
      }
      const length = codePoints ? [...x].length : x.length
      if (p.minLength !== undefined && length < p.minLength) {
        return `Too small: expected string to have >=${p.minLength} characters`
      }
      if (p.maxLength !== undefined && length > p.maxLength) {
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
    case 'array': {
      if (!Array.isArray(x)) return `Invalid input: expected array, received ${typeName(x)}`
      if (p.minItems !== undefined && x.length < p.minItems) {
        return `Too small: expected array to have >=${p.minItems} items`
      }
      if (p.maxItems !== undefined && x.length > p.maxItems) {
        return `Too big: expected array to have <=${p.maxItems} items`
      }
      if (p.items === undefined) return null
      for (const item of x) {
        const problem = checkValue(p.items, item, codePoints)
        if (problem !== null) return problem
      }
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
    const msg = checkValue(prop, value, CODE_POINT_ARGS.has(key))
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

/* The argument names pickArgs drops because the schema does not know them,
 * in the order sent. create_task, update_task and update_project report
 * them (machine/shared.ts withIgnored), so a client with an outdated cached
 * schema learns they changed nothing. */
const unknownArgs = (tool: ToolDef, args: Record<string, unknown>): string[] =>
  Object.keys(args).filter((key) => !Object.hasOwn(tool.inputSchema.properties, key))

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
export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
  ignored: string[],
) => Promise<string>

type ToolOutcome =
  | { kind: 'protocol'; error: { code: number; message: string } }
  | { kind: 'result'; result: Record<string, unknown> }

async function callTool(
  params: Record<string, unknown> | undefined,
  run: ToolRunner,
): Promise<ToolOutcome> {
  const name = params?.name
  const tool = typeof name === 'string' ? TOOL_INDEX.get(name)?.def : undefined
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
    const text = await run(tool.name, pickArgs(tool, args), unknownArgs(tool, args))
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
    // a failure that is no refusal, such as a Convex limit, whose own text
    // can hold a stack trace
    return {
      kind: 'result',
      result: { content: [{ type: 'text', text: internalError(e) }], isError: true },
    }
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
  if (method === 'tools/list') {
    return sseRes(200, { result: { tools: TOOL_DEFS }, jsonrpc: '2.0', id })
  }
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
      result: { tools: TOOL_DEFS, resultType: 'complete', ...CACHE_HINTS, _meta: SERVER_META },
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

/* A parent task named by ref, in the uniform not-found grammar. */
async function mustFindParent(ctx: QueryCtx, me: Caller, ref: string): Promise<Doc<'issues'>> {
  const parent = await findIssue(ctx, me, ref)
  if (parent === null) throw notFound(`parent task "${ref}" not found (or not visible to you)`)
  return parent
}

/* The caller's flags and readable/writable predicates over the whole org
 * catalogue, from one by_org scan and the caller's batched project levels
 * (accessFlags), shared by every scoped read. Writable also needs a
 * credential that may write. */
async function catalogueFlags(ctx: QueryCtx, me: Caller, access: CredentialAccess) {
  const cat = await loadCatalogue(ctx, me)
  const flags = await accessFlags(ctx, me, cat, access)
  return {
    cat,
    flags,
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

/* The forbidden refusal for a project the caller can read but not write
 * (machine/shared.ts MCP_NO_WRITE). */
const noWrite = (): ConvexError<Refusal> => forbidden(MCP_NO_WRITE)

const mustWrite = async (ctx: QueryCtx, me: Caller, projectId: string): Promise<void> => {
  if (!(await hasProjectLevel(ctx, me, projectId, 'user'))) throw noWrite()
}

/* The deployed `text()` body is machine/shared.ts pretty, stringified INSIDE
 * the function so the projections' insertion key order survives the Convex
 * value boundary (which sorts object keys). Every fn below returns these
 * bytes. */

/* --------------------------------------------------- the tool internal fns
 * One per tool, `callerId` and `access` first (the profile uuid the auth
 * query resolved and what its credential may do). asMachineCaller
 * re-asserts the profile, closing the auth-to-dispatch race, and refuses a
 * write from a read-only credential before any ref resolves.
 * Refusal sentences are MCP's: the uniform not-found, the
 * `your account has no write access to that project` write refusal, the
 * machine wordings of the shared rules. */

/* get_me runs lib/core.ts meCore, shared with REST's GET /v1/me. Only this
 * function takes the credential row. */
export const getMe = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, credential: vEventOwner },
  handler: async (ctx, { callerId, access, credential }): Promise<string> => {
    const me = await asMachineCaller(ctx, callerId, access)
    return pretty(await meCore(ctx, me, access, credential))
  },
})

/* list_teams runs model/teams.ts teamsJson, shared with REST's GET /v1/teams. */
export const listTeams = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, { callerId, access }): Promise<string> => {
    const me = await asMachineCaller(ctx, callerId, access)
    return pretty(await teamsJson(ctx, me))
  },
})

/* list_projects: REST GET /v1/projects' rows, with the caller's access flags. */
export const listProjects = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, archived: v.optional(v.boolean()) },
  handler: async (ctx, { callerId, access, archived }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    const { cat, flags, readable } = await catalogueFlags(ctx, me, access)
    return pretty(
      listProjectsCore(cat, archived === true, readable).map((p) =>
        projectJson(p, flags.get(p.id) ?? { read: false, write: false }),
      ),
    )
  },
})

export const listUsers = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, { callerId, access }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    return pretty((await listUsersCore(ctx, me)).map(userJson))
  },
})

export const listProjectUsers = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, project: v.string() },
  handler: async (ctx, { callerId, access, project }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    const { cat, readable } = await catalogueFlags(ctx, me, access)
    const target = findProjectRef(cat, project)
    if (target === undefined || !readable(target.id)) {
      throw notFound(`project "${project}" not found (or not visible to you)`)
    }
    return pretty(await listProjectUsersCore(ctx, me, target))
  },
})

export const updateUser = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    user_id: v.string(),
    plannable_hours: v.number(),
  },
  handler: async (ctx, { callerId, access, user_id, plannable_hours }) => {
    const me = await asMachineCaller(ctx, callerId, access)
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

/* list_tasks answers active tasks as an array paged with `offset`, or with
 * `archived: true` one project's archived tasks as `{next_cursor, tasks}`,
 * paged with `cursor` (lib/core.ts listArchivedIssuesCore). */
export const listIssues = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.optional(v.string()),
    status: v.optional(v.union(vIssueStatus, v.array(vIssueStatus))),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.string()),
    owner_id: v.optional(v.string()),
    search: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const { cat, readable } = await catalogueFlags(ctx, me, a.access)
    let project: Doc<'projects'> | undefined
    if (a.project !== undefined && a.project !== '') {
      project = findProjectRef(cat, a.project)
      if (project === undefined || !readable(project.id)) {
        throw notFound(`project "${a.project}" not found (or not visible to you)`)
      }
    }
    const filters = {
      statuses: typeof a.status === 'string' ? [a.status] : a.status,
      priority: a.priority,
      assignee: a.assignee_id?.toLowerCase(),
      owner: a.owner_id?.toLowerCase(),
      search: a.search,
      stars: false, // MCP has no wildcard, so a literal `*` must not widen
      limit: Math.min(a.limit ?? 50, 200),
    }
    const view = { surface: 'mcp', cat, readable } as const
    // naming a LIVE meta asks for its active tasks as it stands, so a
    // sub-project archived out of it stays out; naming an archived one asks
    // for it as it was put away, and everything under it comes (0106).
    // Archived tasks come one project at a time (taskListScope).
    const req = taskListRequest(view, {
      flag: 'archived: true',
      archived: a.archived === true,
      project,
      offset: a.offset ?? 0,
      cursor: a.cursor,
    })
    if (req.archived === false) {
      return pretty(
        await listActiveIssuesCore(
          ctx,
          me,
          { ...filters, scope: req.scope, offset: req.offset },
          view,
        ),
      )
    }
    const page = await listArchivedIssuesCore(
      ctx,
      me,
      { ...filters, scope: req.scope, cursor: req.cursor },
      view,
    )
    // the cursor first, so a truncated tool result still shows it
    return pretty({
      next_cursor: page.next === null ? null : archiveCursorText(page.next),
      tasks: page.rows,
    })
  },
})

/* get_task answers the single-task shape, the list row plus labels,
 * subtasks, links, a group's remaining hours, followers and attachments
 * (lib/core.ts taskOut). */
export const getIssue = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, { callerId, access, ref }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    const issue = await mustFindIssue(ctx, me, ref)
    return pretty(await taskOut(ctx, issue, { surface: 'mcp', me }))
  },
})

/* list_comments answers a page of the thread, the newest comments or those
 * before the comment `before` names, oldest first (lib/core.ts
 * listCommentsCore). The schema holds `limit` to 1 to COMMENT_PAGE_MAX. */
export const listComments = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    limit: v.optional(v.number()),
    before: v.optional(v.string()),
  },
  handler: async (ctx, { callerId, access, ref, limit, before }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    const issue = await mustFindIssue(ctx, me, ref)
    const rows = await listCommentsCore(ctx, issue.id, {
      limit: limit ?? COMMENT_PAGE_MAX,
      before,
    })
    const names = await orgNames(ctx, me)
    const out = []
    for (const c of rows) out.push(await commentOut(ctx, c, { surface: 'mcp', names }))
    return pretty(out)
  },
})

export const addComment = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, { callerId, access, ref, body }) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, callerId, access)
    const issue = await mustFindIssue(ctx, me, ref)
    const text = body.trim()
    if (text === '') throw badRequest('comment body must not be blank')
    await mustWrite(ctx, me, issue.project_id)
    // 0114 parity through model/comments.ts postComment. The id is made by
    // the server, the author subscribes, mentions fan out and subscribers
    // read 'New comment'. There is deliberately NO activity row, because the
    // comment IS its own feed entry on the discussion spine.
    const comment = await postComment(ctx, { issue, author: me, body: text, now })
    return pretty({ id: comment.id, task: issueKey(issue.num), created_at: now })
  },
})

export const createIssue = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    project: v.string(),
    sub_project: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.optional(vIssueStatus),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.union(v.string(), v.null())),
    reviewer_id: v.optional(v.union(v.string(), v.null())),
    reporter_id: v.optional(v.string()),
    parent: v.optional(v.union(v.string(), v.null())),
    start_week: v.optional(v.union(v.string(), v.null())),
    end_week: v.optional(v.union(v.string(), v.null())),
    due_date: v.optional(v.union(v.string(), v.null())),
    remaining_hours: v.optional(v.union(v.number(), v.null())),
    paused: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    // declared in the schema so the call is refused outright, FIRST and
    // before any other validation, rather than only named in
    // ignored_arguments while an active task is created
    if (a.archived !== undefined) {
      throw badRequest('tasks are created active — archive with update_task after creating')
    }
    const title = cleanTitle(a.title)
    const { cat, readable, writable } = await catalogueFlags(ctx, me, a.access)
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
      metaNeedsSub(p, kids, { readable, writable })
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
    // a subtask: the model checks the parent chain, sight and Edit on it
    const parent = typeof a.parent === 'string' ? await mustFindParent(ctx, me, a.parent) : null
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
        parent_id: parent?.id ?? null,
        start_week: a.start_week ?? null,
        end_week: a.end_week ?? null,
        due_date: a.due_date ?? null,
        remaining_hours: a.remaining_hours ?? null,
        paused: a.paused ?? null,
      },
      now,
      machine: { provenance: PROVENANCE },
    })
    return pretty({ id: row.id, key: issueKey(row.num) })
  },
})

/* update_task. The fields it always had keep their deployed check order
 * (the readable pre-checks before the write gate). A move (`project`,
 * `sub_project`, create's grammar, with Edit on both ends), `parent`, the
 * plan weeks and labels are checked after the gate. With a move, a new
 * assignee or reviewer is checked against the destination. lib/core.ts
 * applyTaskUpdate then writes the change all or nothing, in the order REST's
 * PATCH uses too. */
export const updateIssue = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(vIssueStatus),
    priority: v.optional(vIssuePriority),
    assignee_id: v.optional(v.union(v.string(), v.null())),
    reviewer_id: v.optional(v.union(v.string(), v.null())),
    due_date: v.optional(v.union(v.string(), v.null())),
    start_week: v.optional(v.union(v.string(), v.null())),
    end_week: v.optional(v.union(v.string(), v.null())),
    remaining_hours: v.optional(v.union(v.number(), v.null())),
    paused: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
    archive_reason: v.optional(v.string()),
    project: v.optional(v.string()),
    sub_project: v.optional(v.string()),
    parent: v.optional(v.union(v.string(), v.null())),
    add_labels: v.optional(v.array(v.string())),
    remove_labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId, a.access)
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
    if (a.start_week !== undefined) {
      patch.start_week = a.start_week
      updated.push('start_week')
    }
    if (a.end_week !== undefined) {
      patch.end_week = a.end_week
      updated.push('end_week')
    }
    if (a.remaining_hours !== undefined) {
      patch.remaining_hours = a.remaining_hours
      updated.push('remaining_hours')
    }
    if (a.paused !== undefined) {
      patch.paused = a.paused
      updated.push('paused')
    }
    const moves = a.project !== undefined || a.sub_project !== undefined
    if (a.parent !== undefined) updated.push('parent_id')
    if (moves) updated.push('project_id')
    if (a.add_labels !== undefined || a.remove_labels !== undefined) updated.push('labels')
    // the request's own shape, before anything is looked up
    if (a.archive_reason !== undefined && a.archived !== true) {
      throw badRequest('archive_reason needs archived set to true')
    }
    if (moves && a.project === undefined) {
      throw badRequest(
        'project is required to move a task; sub_project names one of its sub-projects',
      )
    }
    // the readable pre-check sentences fire before the core's rule backstop;
    // resending the current assignee or reviewer is no change and is not
    // checked again, as in the app. A move checks them at its destination,
    // after the write gate.
    const project = await byId(ctx, 'projects', issue.project_id)
    if (project === null) throw notFound('task not found')
    const checkPeople = async (where: Doc<'projects'>): Promise<void> => {
      if (typeof patch.assignee_id === 'string')
        await assertAssignableChange(ctx, where, issue.assignee_id, patch.assignee_id)
      if (typeof patch.reviewer_id === 'string')
        await assertAssignableChange(ctx, where, issue.reviewer_id, patch.reviewer_id, 'reviewer')
    }
    if (!moves) await checkPeople(project)
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
    // a group's dates come from its subtasks, so any date key on one is
    // refused, null and unchanged values included
    if (a.start_week !== undefined || a.end_week !== undefined) await assertNoGroupDates(ctx, issue)
    let destination: Doc<'projects'> | undefined
    if (a.project !== undefined) {
      const { cat, readable, writable } = await catalogueFlags(ctx, me, a.access)
      destination = destinationOf(
        cat,
        { readable, writable },
        { project: a.project, sub_project: a.sub_project },
        (ref) => notFound(`project "${ref}" not found (or not visible to you)`),
      )
      if (!writable(destination.id)) throw noWrite()
      await checkPeople(destination)
    }
    const parent =
      typeof a.parent === 'string' ? (await mustFindParent(ctx, me, a.parent)).id : a.parent
    const labels = await labelChanges(ctx, me.org_id, {
      add: a.add_labels ?? [],
      remove: a.remove_labels ?? [],
    })
    await applyTaskUpdate(ctx, {
      me,
      issue,
      destination,
      parent,
      patch,
      archive: a.archived,
      labels,
      reason: a.archive_reason,
      now,
      provenance: PROVENANCE,
    })
    return pretty({ id: issue.id, key: issueKey(issue.num), updated })
  },
})

export const deleteIssue = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, { callerId, access, ref }) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, callerId, access)
    const issue = await mustFindIssue(ctx, me, ref)
    await mustWrite(ctx, me, issue.project_id)
    await deleteIssueCore(ctx, { me, issue, now, provenance: PROVENANCE })
    return pretty({ deleted: true, key: issueKey(issue.num) })
  },
})

/* set_task_link adds or removes one link, `kind` as seen from `ref`
 * (model/links.ts, the app's rule: sight of both tasks and Edit on either).
 * Asking for the current state changes nothing; `changed` says whether the
 * call did. Adding writes the 'linked' activity row, signed via MCP. */
export const setTaskLink = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    other: v.string(),
    kind: vTaskLinkKind,
    linked: v.boolean(),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await mustFindIssue(ctx, me, a.ref)
    const other = await mustFindIssue(ctx, me, a.other)
    if ((await linkAccess(ctx, me, issue, other)) !== 'write') throw noWrite()
    const changed = a.linked
      ? (
          await addLinkCore(ctx, {
            me,
            ...storedLink(issue.id, a.kind, other.id),
            now,
            provenance: PROVENANCE,
          })
        ).added
      : (await removeLinkCore(ctx, { me, a: issue, b: other, kind: a.kind })) > 0
    return pretty({
      key: issueKey(issue.num),
      other: issueKey(other.num),
      kind: a.kind,
      linked: a.linked,
      changed,
    })
  },
})

/** list_labels answers the organization's labels ordered by name, the same
 * rows as REST's GET /v1/labels (model/labels.ts listLabelsCore). */
export const listLabels = internalQuery({
  args: { callerId: v.string(), access: vCredentialAccess },
  handler: async (ctx, { callerId, access }) => {
    const me = await asMachineCaller(ctx, callerId, access)
    return pretty((await listLabelsCore(ctx, me.org_id)).map(labelJson))
  },
})

/* set_label creates a label without `label` (model/labels.ts
 * createLabelCore: an organization admin, or the User role with Edit on a
 * top-level project), or renames or recolors the one `label` names
 * (updateLabelCore: organization admins only, checked before the lookup).
 * `created` tells which. */
export const setLabel = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    label: v.optional(v.string()),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const now = new Date().toISOString()
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    if (a.label === undefined) {
      await assertLabelCreator(ctx, me)
      if (a.name === undefined || a.color === undefined) {
        throw badRequest('a new label needs name and color')
      }
      const label = await createLabelCore(ctx, {
        me,
        id: newUuid(),
        name: a.name,
        color: a.color,
        now,
        provenance: PROVENANCE,
      })
      return pretty({ ...labelJson(label), created: true })
    }
    assertLabelManager(me)
    const label = await findLabel(ctx, me.org_id, a.label)
    if (label === null) throw notFound(`label "${a.label}" not found`)
    if (a.name === undefined && a.color === undefined) throw badRequest('no fields to update')
    const after = await updateLabelCore(ctx, { me, label, name: a.name, color: a.color })
    return pretty({ ...labelJson(after), created: false })
  },
})

/* --------------------------------------------------------- tool dispatcher
 * Validated, stripped wire arguments → the tool's registry entry, run with
 * the narrowest runner its access flag allows. */

async function runTool(
  ctx: ActionCtx,
  principal: Principal,
  credential: EventOwner,
  name: string,
  args: Record<string, unknown>,
  ignored: string[],
): Promise<string> {
  const tool = TOOL_INDEX.get(name)
  // Unreachable, because callTool resolves names against TOOL_INDEX first.
  if (tool === undefined) throw new Error(`unknown tool ${name}`)
  return await runEntry(ctx, tool, { ...principal, credential, args, ignored })
}

/* Whether the named tool needs qivo:write. A known tool does unless its flag
 * is exactly 'read' (needsWrite fails closed). An unknown name needs no write
 * scope, because the dispatcher answers it with -32602 before any runner
 * exists. */
const toolWrites = (name: string): boolean => {
  const tool = TOOL_INDEX.get(name)
  return tool !== undefined && needsWrite(tool)
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

/* The OAuth step-up before dispatch. It answers HTTP 403 insufficient_scope
 * when the grant lacks qivo:read, or lacks qivo:write while any call in the
 * body names a tool whose registry entry is a write; null lets it through. */
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
        toolWrites(rpc.params.name)
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

/* The OAuth connection a request runs as, in webhook ownership's shape. */
const oauthOwner = (live: {
  profileId: string
  connectionId: string
  connectionRowId: string
}): EventOwner => ({
  profile_id: live.profileId,
  credential_table: 'oauth_connections',
  credential_id: live.connectionId,
  credential_row_id: live.connectionRowId,
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
    const bodyText = await readBody(request)
    if (bodyText === null) return jsonRes(413, TOO_LARGE)
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
            owner: oauthOwner(live),
            method,
            params_json: JSON.stringify(params),
          })
        },
        runTool: async (name, args, ignored) => {
          // Both protocol versions enter this same gate. Recheck the live grant
          // on every tool in a batch, alongside the existing permission checks,
          // and pass its live access, so scopes narrowed mid-session apply.
          const live = await ctx.runQuery(internal.oauthConnections.lookupAccess, {
            tokenHash,
            resource,
          })
          if (!live) throw forbidden('OAuth connection is invalid, expired or disconnected')
          const scope = toolWrites(name) ? 'qivo:write' : 'qivo:read'
          if (!live.scopes.includes(scope))
            throw forbidden(`This connection does not have the ${scope} scope.`)
          return runTool(
            ctx,
            { callerId: live.profileId, access: live.access },
            oauthOwner(live),
            name,
            args,
            ignored,
          )
        },
      })
    } catch (error) {
      if (
        error instanceof ConvexError &&
        [CALLER_GONE, CALLER_DEACTIVATED].includes((error.data as Refusal).reason || '')
      )
        return unauthorized('OAuth connection is invalid, expired or disconnected')
      return jsonRes(500, { error: internalError(error) })
    }
  }
  const res = await authenticateSecret(ctx, secret)
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
  const bodyText = await readBody(request)
  if (bodyText === null) return jsonRes(413, TOO_LARGE)
  // the exact credential row this request runs as, for get_me and events/*
  const owner: EventOwner = {
    profile_id: cred.profileId,
    credential_table: cred.isAgent ? 'agent_keys' : 'mcp_tokens',
    credential_id: cred.tokenId,
    credential_row_id: cred.rowId,
  }
  try {
    return await dispatchMcp({
      headers: request.headers,
      bodyText,
      runTool: (name, args, ignored) =>
        runTool(ctx, { callerId: cred.profileId, access: cred.access }, owner, name, args, ignored),
      runEvent: (method, params) =>
        ctx.runAction(internal.webhookActions.manage, {
          owner,
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
    return jsonRes(500, { error: internalError(e) })
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
