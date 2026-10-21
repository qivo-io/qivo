/* The per-task caps on attachments, links and labels
   (convex/lib/taskLimits.ts), as the task window's controls read them. Each
   answers why a task can take no more of one kind, as a control's tooltip
   and the store's toast, or undefined when it can. The server refuses past
   the same caps with its own sentence.

   The view counts what it holds. That is every attachment and description
   image of the task and every label it carries, but only the links whose
   other task the reader is shown, so a task whose other links are hidden or
   archived can still be refused when the link is made. */

import { ATTACHMENT_MAX, LABEL_MAX, LINK_MAX } from '../../convex/lib/taskLimits'

/** Why a task with `count` attachment rows, files and description images
 * together, can take no more. */
export const attachmentBlock = (count: number): string | undefined =>
  count >= ATTACHMENT_MAX
    ? `This task has ${ATTACHMENT_MAX} attachments, images in its description included, the most a task can have`
    : undefined

/** Why a task with `links` can take no more links, naming it by `key` when
 * given and as "This task" otherwise. */
export const linkBlock = (links: readonly unknown[], key?: string): string | undefined =>
  links.length >= LINK_MAX
    ? `${key ?? 'This task'} has ${LINK_MAX} links, the most a task can have`
    : undefined

/** Why a task with `labels` can carry no more labels. */
export const labelBlock = (labels: readonly unknown[]): string | undefined =>
  labels.length >= LABEL_MAX
    ? `This task has ${LABEL_MAX} labels, the most a task can have`
    : undefined
