/* The per-task caps on attachments, links and labels (LIMITS.attachments,
   LIMITS.links and LIMITS.labels in convex/lib/limits.ts), as the task
   window's controls read them. Each answers why a task can take no more of
   one kind, as a control's tooltip and the store's toast, or undefined when
   it can. It is the registry sentence the server's refusal shows.

   The view counts what it holds. That is every attachment and description
   image of the task and every label it carries, but only the links whose
   other task the reader is shown, so a task whose other links are hidden or
   archived can still be refused when the link is made. */

import { LIMITS, linksFull } from '../../convex/lib/limits'
import { limitSentence, sentence } from './fieldLimits'

/** Why a task with `count` attachment rows, files and description images
 * together, can take no more. */
export const attachmentBlock = (count: number): string | undefined =>
  count >= LIMITS.attachments.max ? limitSentence(LIMITS.attachments) : undefined

/** Why a task with `links` can take no more links, naming it by `key` when
 * given and as "This task" otherwise. */
export const linkBlock = (links: readonly unknown[], key?: string): string | undefined =>
  links.length >= LIMITS.links.max ? sentence(linksFull(key ?? 'this task')) : undefined

/** Why a task with `labels` can carry no more labels. */
export const labelBlock = (labels: readonly unknown[]): string | undefined =>
  labels.length >= LIMITS.labels.max ? limitSentence(LIMITS.labels) : undefined
