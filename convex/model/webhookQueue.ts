import { makeFunctionReference } from 'convex/server'
import type { MutationCtx } from '../_generated/server'

export const dispatchWebhooksRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'webhookQueue:dispatch',
)

export const deliverEventRef = makeFunctionReference<'action', { id: string }, null>(
  'webhookActions:deliver',
)

export const expandWebhookEventsRef = makeFunctionReference<
  'mutation',
  Record<string, never>,
  null
>('webhookQueue:expand')

export const runWebhookWorkerRef = makeFunctionReference<
  'mutation',
  { kind: 'expand' | 'dispatch'; generation: string },
  null
>('webhookQueue:run')

const wakes = new WeakSet<MutationCtx>()

/** One wake per transaction, without reading a queue range shared by other organizations. */
export async function requestWebhookDispatch(ctx: MutationCtx): Promise<void> {
  if (wakes.has(ctx)) return
  wakes.add(ctx)
  await ctx.scheduler.runAfter(0, dispatchWebhooksRef, {})
}
