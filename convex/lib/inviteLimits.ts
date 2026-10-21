/* The hourly cap on the app's invitation emails, shared by the server
 * (convex/invites.ts) and the app, which names it when a send is held back.
 * No imports, so the app can import this file as it does textLimits.ts. */

/** App invitation emails allowed per organization per rolling hour,
 * console sends included. The emails leave from the shared no-reply
 * address, and any org admin can trigger them. */
export const APP_SENDS_PER_ORG_HOUR = 50

/** The refusal of a send again while the organization's hour is full. A
 * `rule`, so the app shows it. */
export const INVITES_HELD = `this organization sent ${APP_SENDS_PER_ORG_HOUR} invitation emails in the last hour, the most it can send; send this one again once the hour has passed`

/** The refusal of a send again while the seat's newest invitation email is
 * still being sent. */
export const INVITE_SENDING = 'this invitation email is being sent; wait for it to finish'
