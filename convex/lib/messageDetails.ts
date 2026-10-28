/* Sentences the server writes as an inbox message's detail
 * (messages.detail), shared with the app, which tells from them where the
 * message's subject shows. */

/** The detail of a mention message (kind 'mention'). A mention in the
 * description comes with the description's edit, a change the task window
 * lists only under All; one in a comment shows with the comment. */
export const MENTION_DETAILS = {
  description: 'Mentioned you in the description',
  comment: 'Mentioned you in a comment',
} as const
