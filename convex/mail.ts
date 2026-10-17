/* Qivo transactional mail uses the shared AgentMail account for verification,
 * password resets, billing reminders and organization invitations. The
 * configured inbox supplies From; customer replies go to support. No inbound
 * mail is processed here.
 *
 * AGENTMAIL_API_KEY, AGENTMAIL_INBOX and AGENTMAIL_BASE_URL belong only in the
 * selected Convex deployment. Never log keys, inboxes, recipients or auth URLs.
 * Local auth-link logging requires an explicit loopback development opt-in. */

import { v } from 'convex/values'
import { internalAction } from './_generated/server'
import { localAuthEmailLogging, requireAuthMailDelivery } from './lib/mailConfig'
import { cutName } from './lib/textLimits'

/* Web-platform globals the Convex isolate provides; convex/tsconfig's lib is
 * ESNext only, which does not declare them (same move as model/orgs). */
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> }
}
declare class TextEncoder {
  encode(input: string): Uint8Array
}
interface AbortSignal {
  readonly aborted: boolean
}
declare const AbortSignal: { timeout(ms: number): AbortSignal }
declare function setTimeout(cb: () => void, ms: number): unknown
type SendResponse = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}
declare function fetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<SendResponse>

// Use the API host for the shared account's region. The deleted account's
// region is not evidence for a replacement key. Keep the deployment override.
const MAIL_BASE_DEFAULT = 'https://api.agentmail.to'

const SEND_TIMEOUT_MS = 10_000
const SEND_ATTEMPTS = 3

/* ONE address, and nothing that could be read as two — the recipient is
 * user-typed at sign-up, and whether a comma fans out or a `<` rewrites the
 * From is the provider's business, which is precisely why it must not be
 * decided there. 254 is the RFC 5321 ceiling on a path. */
const ADDR =
  /^[^\s@,;:<>"'\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const address = (s: string): string | null => (s.length <= 254 && ADDR.test(s) ? s : null)

// ---------------------------------------------------------------- templates
// Server-side constants, `text` AND `html` for every one of them: an
// HTML-only body is what spam filters flag, and the sender below refuses a
// letter carrying only one of the two. Subjects are constants — no database
// text reaches a header, so send-mail's hdr() scrubber has nothing to scrub.

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const shell = (paragraphs: string[], cta: { href: string; label: string }) =>
  `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328;max-width:36em">
${paragraphs.map((p) => `  <p style="margin:0 0 1em">${p}</p>`).join('\n')}
  <p style="margin:1.5em 0"><a href="${esc(cta.href)}" style="display:inline-block;padding:10px 18px;background:#6D7BF2;color:#fff;border-radius:6px;text-decoration:none">${esc(cta.label)}</a></p>
  <p style="margin:2em 0 0;font-size:13px;color:#6a737d">Qivo — work planning</p>
</div>`.trim()

type Letter = { to: string; subject: string; text: string; html: string }

// AgentMail takes From from AGENTMAIL_INBOX, not from the message body.

const verifyLetter = (to: string, url: string): Letter => ({
  to,
  subject: 'Confirm your email address on Qivo',
  text: `Hi,

Confirm your email address to finish setting up your Qivo account:
${url}

If you did not create a Qivo account, you can ignore this message.`,
  html:
    shell(['Hi,', 'Confirm your email address to finish setting up your Qivo account.'], {
      href: url,
      label: 'Confirm email address',
    }) +
    '\n<p style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#6a737d;max-width:36em">If you did not create a Qivo account, you can ignore this message.</p>',
})

const resetLetter = (to: string, url: string): Letter => ({
  to,
  subject: 'Reset your Qivo password',
  text: `Hi,

Someone asked to reset the password for your Qivo account. If that was you, set a new password here:
${url}

If it was not you, you can ignore this message — your password is unchanged.`,
  html:
    shell(
      [
        'Hi,',
        'Someone asked to reset the password for your Qivo account. If that was you, set a new password below.',
      ],
      { href: url, label: 'Reset password' },
    ) +
    '\n<p style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#6a737d;max-width:36em">If it was not you, you can ignore this message — your password is unchanged.</p>',
})

// ------------------------------------------------------------------- sender

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/* Idempotency key = sha256 hex of the Better Auth URL: every send carries a
 * unique token in the url, so postLetter's internal retries share the key
 * while a genuinely new request (new token) is a new mail — which is correct.
 * Hex stays inside the key charset, and it is never an empty string (an
 * explicitly empty Idempotency-Key is a 400 rather than "no key"). */
const sha256Hex = async (s: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

/* One letter, up to three attempts, nothing thrown — send-mail's postLetter.
 * A batch caller may pass a deadline (epoch ms) shared by its letters. Each
 * attempt's timeout and each wait then stop at it, and a letter that cannot
 * finish in time counts as not sent.
 *
 * Retry covers 408 / 429 / 5xx and a network or timeout failure. 409 gets
 * exactly ONE extra attempt: under the same idempotency key a 409 means
 * EITHER "the original send is still in flight", whose documented remedy is
 * to repeat the identical request, OR "a different body", which no number of
 * repeats will fix — one repeat covers the first without spending three calls
 * on the second. Everything else — auth, validation, a rejected recipient —
 * is final, and repeating it just spends a rate limit whose ceiling is not
 * published.
 *
 * The provider's reply body is {code, message, docs, fix} on an application
 * error but NOT on an auth failure: a missing or wrong key is rejected at the
 * gateway with a bare {"message":"Unauthorized"} and no code at all — exactly
 * the first failure a fresh deployment produces — so this branches on the
 * STATUS and treats `code` as a bonus. */
async function postLetter(
  letter: Letter,
  intent: string,
  cfg: {
    key: string
    inbox: string
    idempotencyKey: string
    deadline?: number
    /* Called for each failed request. 'refused' is a final provider answer
     * (a 4xx other than 408, 409 and 429), so nothing was sent. 'ambiguous'
     * is a timeout, network error, conflict, rate limit or server error,
     * after which the letter may still have been delivered. */
    onFailure?: (kind: 'refused' | 'ambiguous') => void
  },
): Promise<boolean> {
  if (!letter.text.trim() || !letter.html.trim()) {
    console.error('[mail] refusing an incomplete template', { intent })
    return false
  }
  const to = address(letter.to)
  if (to === null) {
    // the reason, never the value — an address in a log is an address in a
    // second place
    console.error('[mail] refusing a letter', { intent, reason: 'bad address' })
    return false
  }
  const base = (process.env.AGENTMAIL_BASE_URL ?? MAIL_BASE_DEFAULT).replace(/\/+$/, '')
  const url = `${base}/v0/inboxes/${encodeURIComponent(cfg.inbox)}/messages/send`
  const body = JSON.stringify({
    to: [to],
    reply_to: ['support@qivo.io'],
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  })
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    let retryAfterMs = 0
    const left = cfg.deadline === undefined ? SEND_TIMEOUT_MS : cfg.deadline - Date.now()
    if (left <= 0) {
      console.error('[mail] send deadline passed', { intent, attempt })
      return false
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': cfg.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(Math.min(SEND_TIMEOUT_MS, left)),
      })
      if (res.ok) {
        const ok = (await res.json().catch(() => null)) as { message_id?: string } | null
        // ids only — no address, no subject
        console.log('[mail] sent', { intent, message_id: ok?.message_id ?? null })
        return true
      }
      const detail = (await res.json().catch(() => null)) as { code?: unknown } | null
      const code = typeof detail?.code === 'string' ? detail.code : null
      const ambiguous =
        res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500
      const retryable = ambiguous && (res.status !== 409 || attempt === 1)
      cfg.onFailure?.(ambiguous ? 'ambiguous' : 'refused')
      console.error('[mail] provider refused', { intent, status: res.status, code, attempt })
      if (!retryable || attempt === SEND_ATTEMPTS) return false
      const after = Number(res.headers.get('Retry-After'))
      retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : 0
    } catch (e) {
      /* MANDATORY own catch. A fetch failure stringifies with the url, and
       * the url carries the inbox address — only the error's NAME
       * (TypeError, TimeoutError) is safe to record. */
      console.error('[mail] provider unreachable', {
        intent,
        name: (e as Error)?.name ?? 'error',
        attempt,
      })
      cfg.onFailure?.('ambiguous')
      if (attempt === SEND_ATTEMPTS) return false
    }
    const wait = retryAfterMs > 0 ? retryAfterMs : attempt * 500
    if (cfg.deadline !== undefined && Date.now() + wait >= cfg.deadline) {
      console.error('[mail] send deadline passed', { intent, attempt })
      return false
    }
    await new Promise<void>((r) => setTimeout(() => r(), wait))
  }
  return false
}

/** Billing reminders use the same transport, but never log recipients/URLs
 * when unconfigured. A stable notice key deduplicates provider retries. */
export async function sendBillingReminder(input: {
  to: string
  url: string
  until: string
  notice_key: string
}): Promise<boolean> {
  const key = process.env.AGENTMAIL_API_KEY
  const inbox = process.env.AGENTMAIL_INBOX
  if (!key || !inbox || process.env.APP_MODE === 'demo') return false
  const expired = Date.parse(input.until) <= Date.now()
  const date = input.until.slice(0, 10)
  const message = expired
    ? `Your complimentary Qivo access ended on ${date}. Your organization is read-only, and it will be deleted 30 days later unless an administrator subscribes.`
    : `Your complimentary Qivo access ends on ${date}. No card is on file for this free access, and you will not be charged automatically. You can subscribe in Billing when the free period ends. Without a subscription, the organization becomes read-only and is deleted 30 days later.`
  const letter = {
    to: input.to,
    subject: expired
      ? 'Your complimentary Qivo access has ended'
      : 'Your complimentary Qivo access ends soon',
    text: `${message}\n\nOpen Billing:\n${input.url}`,
    html: shell([esc(message)], { href: input.url, label: 'Open Billing' }),
  }
  return await postLetter(letter, 'billing', {
    key,
    inbox,
    idempotencyKey: await sha256Hex(input.notice_key),
  })
}

export type InviteOutcome = 'sent' | 'unsent' | 'uncertain'

/** Organization invitations (invites.ts), from the operator console and the
 * app, use the same transport and From inbox. The organization name is stored
 * text, so it appears only in the body, folded to one line, capped and escaped
 * in HTML, never in the subject. A guest invitation ends its sentence with
 * "as a guest". The outcome is 'sent' when the provider accepted the letter,
 * 'uncertain' when a request failed in a way that may still have delivered it
 * (timeout, network error, conflict, rate limit or server error), and
 * 'unsent' otherwise, that is, when the provider gave a final refusal or no
 * request reached it (mail not configured, demo, or the batch deadline passed
 * first).
 * For anything but 'sent' the console offers the sign-up link, and the app's
 * sends are only recorded. A fresh key per send lets a resend produce a new
 * letter while keeping postLetter's retries idempotent. */
export async function sendInviteEmail(input: {
  to: string
  org_name: string
  as_guest: boolean
  url: string
  send_key: string
  deadline: number
}): Promise<InviteOutcome> {
  const key = process.env.AGENTMAIL_API_KEY
  const inbox = process.env.AGENTMAIL_INBOX
  if (!key || !inbox || process.env.APP_MODE === 'demo') return 'unsent'
  // a name stored before the NAME_MAX cap can be longer, so it is cut here
  const org = cutName(input.org_name.replace(/\s+/g, ' ').trim())
  const join = (name: string) =>
    `${name} has invited you to join their organization${input.as_guest ? ' as a guest' : ''}.`
  const letter: Letter = {
    to: input.to,
    subject: 'You are invited to Qivo',
    text: `Hi,

${join(org)} Sign in or create an account with ${input.to} to join:
${input.url}`,
    html: shell(
      [
        'Hi,',
        `${join(`<strong>${esc(org)}</strong>`)} Sign in or create an account with ${esc(input.to)} to join.`,
      ],
      { href: input.url, label: 'Accept invitation' },
    ),
  }
  let ambiguous = false
  const ok = await postLetter(letter, 'invite', {
    key,
    inbox,
    idempotencyKey: await sha256Hex(input.send_key),
    deadline: input.deadline,
    onFailure: (kind) => {
      if (kind === 'ambiguous') ambiguous = true
    },
  })
  return ok ? 'sent' : ambiguous ? 'uncertain' : 'unsent'
}

/** Tells one admin that the organization is read-only and will be deleted.
 * orgRemovals.ts sends it when the read-only period starts and nobody has
 * exported in the week before. The organization name stays in the body,
 * folded and capped as in an invitation. A stable notice key deduplicates
 * provider retries. */
export async function sendDeletionNotice(input: {
  to: string
  org_name: string
  delete_after: string
  reason: string
  url: string
  notice_key: string
}): Promise<boolean> {
  const key = process.env.AGENTMAIL_API_KEY
  const inbox = process.env.AGENTMAIL_INBOX
  if (!key || !inbox || process.env.APP_MODE === 'demo') return false
  const org = cutName(input.org_name.replace(/\s+/g, ' ').trim())
  const lead = (name: string) =>
    `${name} is read-only and will be deleted on ${input.delete_after.slice(0, 10)}, with all of its projects, tasks, comments and files.`
  const rest = [
    'Nobody has exported its data in the last 7 days. Export it in Settings if you want a copy.',
    input.reason === 'requested'
      ? 'An organization admin can stop the deletion in Settings before then.'
      : 'Subscribing in Billing before then keeps the organization.',
  ].join(' ')
  const letter: Letter = {
    to: input.to,
    subject: 'Export your Qivo data before it is deleted',
    text: `Hi,

${lead(org)} ${rest}

Open Settings:
${input.url}`,
    html: shell(['Hi,', `${lead(`<strong>${esc(org)}</strong>`)} ${esc(rest)}`], {
      href: input.url,
      label: 'Export data',
    }),
  }
  return await postLetter(letter, 'deletion', {
    key,
    inbox,
    idempotencyKey: await sha256Hex(input.notice_key),
  })
}

// ------------------------------------------------------------------- action

export const send = internalAction({
  args: {
    to: v.string(),
    intent: v.union(v.literal('verify'), v.literal('reset')),
    url: v.string(),
  },
  handler: async (_ctx, { to, intent, url }) => {
    if (process.env.APP_MODE === 'demo') return
    requireAuthMailDelivery()
    const key = process.env.AGENTMAIL_API_KEY
    if (key === undefined || key === '') {
      if (!localAuthEmailLogging()) throw new Error('Local auth-link logging is disabled')
      console.log(`[mail] local-development intent=${intent} url=${url}`)
      return
    }
    const inbox = process.env.AGENTMAIL_INBOX
    if (inbox === undefined || inbox === '') {
      throw new Error('Authentication email is unavailable. Configure AGENTMAIL_INBOX.')
    }
    const letter = intent === 'verify' ? verifyLetter(to, url) : resetLetter(to, url)
    if (!(await postLetter(letter, intent, { key, inbox, idempotencyKey: await sha256Hex(url) }))) {
      throw new Error('Authentication email delivery failed')
    }
  },
})
