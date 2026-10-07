import { type Infer, v } from 'convex/values'

export const WEBHOOK_MIN_TTL_MS = 60_000
export const WEBHOOK_MAX_TTL_MS = 7 * 24 * 60 * 60_000
export const WEBHOOK_MAX_ATTEMPTS = 8
export const WEBHOOK_RETRY_BASE_MS = 10_000
export const WEBHOOK_LEASE_MS = 60_000
export const WEBHOOK_ORG_CONCURRENCY = 5

export const EVENT_NAMES = [
  'task.created',
  'task.updated',
  'task.deleted',
  'comment.created',
] as const
export type EventName = (typeof EVENT_NAMES)[number]
export const vEventName = v.union(...EVENT_NAMES.map((name) => v.literal(name)))
export const vEventOwner = v.object({
  profile_id: v.string(),
  credential_table: v.union(
    v.literal('agent_keys'),
    v.literal('mcp_tokens'),
    v.literal('oauth_connections'),
  ),
  credential_id: v.string(),
  credential_row_id: v.string(),
})
export const vEventFilters = v.object({
  task_id: v.optional(v.string()),
  project_id: v.optional(v.string()),
})
export type EventOwner = Infer<typeof vEventOwner>
export type EventFilters = Infer<typeof vEventFilters>

export const EVENT_CATALOG = EVENT_NAMES.map((name) => ({
  name,
  description: {
    'task.created': 'A task was created in a project you can read.',
    'task.updated':
      'Stored task fields changed, including scheduling, assignment, archiving and restoration.',
    'task.deleted': 'A task was deleted. Deleting its project does not deliver task.deleted.',
    'comment.created': 'A comment was added to a task. Use list_comments to read the discussion.',
  }[name],
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task UUID. Omit to monitor all readable tasks.' },
      project_id: {
        type: 'string',
        description: 'Exact project UUID. Does not include child projects.',
      },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      task_ref: { type: 'string' },
      project_id: { type: 'string' },
      actor_id: { type: ['string', 'null'] },
      changed_fields: { type: 'array', items: { type: 'string' } },
    },
    required: ['task_id', 'task_ref', 'project_id', 'actor_id', 'changed_fields'],
    additionalProperties: false,
  },
}))

export type EventReply =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: Record<string, unknown> } }

/** HTTP acknowledgments and retry policy are shared by actions and durable completion. */
export function permanentWebhookStatus(status: number): boolean {
  return status >= 300 && status < 500 && ![408, 425, 429].includes(status)
}

/** Expiry is optional. Disabled callbacks remain available for inspection. */
export function subscriptionActive(subscription: {
  expires_at?: number
  disabled_at?: number
}): boolean {
  return (
    subscription.disabled_at === undefined &&
    (subscription.expires_at === undefined || subscription.expires_at > Date.now())
  )
}
