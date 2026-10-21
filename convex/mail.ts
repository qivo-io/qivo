/* Qivo transactional mail goes through Lettermint's sending API for
 * verification, password resets, the two account notes that keep sign-up and
 * reset answers alike for every address, billing reminders, deletion notices
 * and organization invitations. MAIL_FROM supplies From; customer replies go to
 * support. No inbound mail is processed here.
 *
 * LETTERMINT_API_KEY (a project API token) and MAIL_FROM belong only in the
 * selected Convex deployment. Never log tokens, recipients or auth URLs. Local
 * auth-link logging requires an explicit loopback development opt-in. */

import type { AuthMailOutcome } from './lib/authMail'
import { address, localAuthEmailLogging, mailFrom, mailSendUrl } from './lib/mailConfig'
import { cutName } from './lib/textLimits'

/* Web-platform globals the Convex isolate provides; convex/tsconfig's lib is
 * ESNext only, which does not declare them (same move as model/orgs). */
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> }
  randomUUID(): string
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
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
    redirect: 'error'
  },
): Promise<SendResponse>

const REPLY_TO = 'support@qivo.io'

const SEND_TIMEOUT_MS = 10_000
const SEND_ATTEMPTS = 3
// how long a sign-up, sign-in or reset request waits for its letter
const AUTH_SEND_BUDGET_MS = 20_000
// the longest Retry-After a send waits out before it gives up
const MAX_RETRY_WAIT_MS = 30_000

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
  <p style="margin:2em 0 0;font-size:13px;color:#6a737d">Qivo, work planning</p>
</div>`.trim()

type Letter = { to: string; subject: string; text: string; html: string }

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

If it was not you, you can ignore this message. Your password is unchanged.`,
  html:
    shell(
      [
        'Hi,',
        'Someone asked to reset the password for your Qivo account. If that was you, set a new password below.',
      ],
      { href: url, label: 'Reset password' },
    ) +
    '\n<p style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#6a737d;max-width:36em">If it was not you, you can ignore this message. Your password is unchanged.</p>',
})

/* Sent instead of a confirmation link when someone signs up with an address
 * that already has an account. Every sign-up then sends one letter, so the
 * answer, and any failure to send, looks the same for every address. */
const existingLetter = (to: string, url: string): Letter => ({
  to,
  subject: 'Your Qivo account',
  text: `Hi,

Someone tried to create a Qivo account with this email address, which already has one. If that was you, sign in instead:
${url}

If you have forgotten your password, choose Forgot password on the sign-in page. If it was not you, you can ignore this message.`,
  html:
    shell(
      [
        'Hi,',
        'Someone tried to create a Qivo account with this email address, which already has one. If that was you, sign in instead.',
      ],
      { href: url, label: 'Sign in' },
    ) +
    '\n<p style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#6a737d;max-width:36em">If you have forgotten your password, choose Forgot password on the sign-in page. If it was not you, you can ignore this message.</p>',
})

/* Sent instead of a reset link when no account uses the address, for the
 * same reason as existingLetter. */
const unknownLetter = (to: string, url: string): Letter => ({
  to,
  subject: 'Your Qivo password reset request',
  text: `Hi,

Someone asked to reset the password for a Qivo account with this email address, but no account uses it. If that was you, you may have signed up with another address. You can also create an account:
${url}

If it was not you, you can ignore this message.`,
  html:
    shell(
      [
        'Hi,',
        'Someone asked to reset the password for a Qivo account with this email address, but no account uses it. If that was you, you may have signed up with another address. You can also create an account.',
      ],
      { href: url, label: 'Create an account' },
    ) +
    '\n<p style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#6a737d;max-width:36em">If it was not you, you can ignore this message.</p>',
})

const AUTH_LETTERS = {
  verify: verifyLetter,
  reset: resetLetter,
  existing: existingLetter,
  unknown: unknownLetter,
}
export type AuthLetterIntent = keyof typeof AUTH_LETTERS

// ------------------------------------------------------------------- sender

/** The configured sender, or null when mail is off: no token, a MAIL_FROM
 * that is not one bare address, or the demo. A token beside an unusable
 * MAIL_FROM is logged, without either value. */
function sender(): { token: string; from: string } | null {
  const token = process.env.LETTERMINT_API_KEY
  if (!token || process.env.APP_MODE === 'demo') return null
  const from = mailFrom()
  if (from === null) {
    console.error('[mail] MAIL_FROM is not one address, so nothing was sent')
    return null
  }
  return { token, from }
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/* Idempotency key = sha256 hex of the Better Auth URL: every send carries a
 * unique token in the url, so postLetter's internal retries share the key
 * while a genuinely new request (new token) is a new mail — which is correct.
 * The 64 hex characters stay inside the provider's 1 to 255, and the key is
 * never empty (an invalid Idempotency-Key is a 422 rather than "no key"). */
const sha256Hex = async (s: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

/* The idempotency key of a billing or deletion notice: its notice key and
 * the hourly attempt that billingMail.ts and orgRemovals.ts count. postLetter's
 * quick retries share it, and each hourly attempt gets a new one. Lettermint
 * blocks a key for 24 hours after a server error whose outcome is unknown,
 * and replays a sandbox acceptance for as long, so a key kept across hours
 * could run out a notice's whole day of attempts unsent. A server error that
 * did deliver the letter can instead lead to a second copy an hour later. */
const noticeKey = (input: { notice_key: string; attempt: number }) =>
  sha256Hex(`${input.notice_key}:${input.attempt}`)

/* One letter, up to three attempts, nothing thrown — send-mail's postLetter.
 * A batch caller may pass a deadline (epoch ms) shared by its letters. Each
 * attempt's timeout and each wait then stop at it, and a letter that cannot
 * finish in time counts as not sent.
 *
 * Retry covers 408 / 429 / 5xx and a network or timeout failure, under the
 * same idempotency key. Lettermint keeps a key for 24 hours per project and
 * answers a repeat of an accepted request with the first 202. A 409 gets ONE
 * extra attempt per call, on whichever attempt it arrives: under the same key
 * it means EITHER "the original send is still being processed", typically
 * after our own attempt timed out, which a repeat can outlast, OR "a
 * different body" or "an earlier attempt failed after the letter may have
 * been sent", which no number of repeats will fix. Lettermint gives the
 * first and the last the same error code. Everything else (401 token, 403
 * plan feature, 413 size, 422 validation, a rejected recipient) is final. A
 * Retry-After beyond MAX_RETRY_WAIT_MS ends the call instead, so the action
 * stays far inside its time limit and the caller's own retry takes over.
 * Redirects are refused, because fetch would forward the token header to
 * another origin.
 *
 * The provider's reply body is {error: {code, message, details}} on most
 * errors, but a bare {message} or {message, errors} on others, and a message
 * can echo what was sent. So this branches on the STATUS, logs `error.code`
 * only as a bonus, and never logs a message. */
async function postLetter(
  letter: Letter,
  intent: string,
  cfg: {
    sender: { token: string; from: string }
    idempotencyKey: string
    deadline?: number
    /* Called for each failed request. 'refused' means nothing was sent: a
     * final provider answer (a 4xx other than 408, 409 and 429) or a sandbox
     * acceptance. 'ambiguous' is a timeout, network error, conflict, rate
     * limit or server error, after which the letter may still have been
     * delivered. */
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
  const body = JSON.stringify({
    from: `Qivo <${cfg.sender.from}>`,
    to: [to],
    reply_to: [REPLY_TO],
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  })
  let conflictRepeated = false
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    let retryAfterMs = 0
    const left = cfg.deadline === undefined ? SEND_TIMEOUT_MS : cfg.deadline - Date.now()
    if (left <= 0) {
      console.error('[mail] send deadline passed', { intent, attempt })
      return false
    }
    try {
      const res = await fetch(mailSendUrl(), {
        method: 'POST',
        headers: {
          'x-lettermint-token': cfg.sender.token,
          'Content-Type': 'application/json',
          'Idempotency-Key': cfg.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(Math.min(SEND_TIMEOUT_MS, left)),
        redirect: 'error',
      })
      if (res.ok) {
        const ok = (await res.json().catch(() => null)) as {
          message_id?: string
          sandbox?: boolean
        } | null
        const message_id = ok?.message_id ?? null
        if (ok?.sandbox === true) {
          /* A sandbox project accepts a letter and delivers nothing. Counting
           * it as not sent keeps billing and deletion notices retrying hourly,
           * each attempt under a new key, and keeps invitations offering
           * their link until the project is live. */
          console.error('[mail] provider is in sandbox mode, nothing was delivered', {
            intent,
            message_id,
          })
          cfg.onFailure?.('refused')
          return false
        }
        // ids only — no address, no subject
        console.log('[mail] sent', { intent, message_id })
        return true
      }
      const detail = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
      const code = typeof detail?.error?.code === 'string' ? detail.error.code : null
      const ambiguous =
        res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500
      const retryable = ambiguous && (res.status !== 409 || !conflictRepeated)
      if (res.status === 409) conflictRepeated = true
      cfg.onFailure?.(ambiguous ? 'ambiguous' : 'refused')
      console.error('[mail] provider refused', { intent, status: res.status, code, attempt })
      if (!retryable || attempt === SEND_ATTEMPTS) return false
      const after = Number(res.headers.get('Retry-After'))
      retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : 0
    } catch (e) {
      /* MANDATORY own catch. A fetch failure's message and cause can carry
       * request details, so only the error's NAME (TypeError, TimeoutError)
       * is safe to record. */
      console.error('[mail] provider unreachable', {
        intent,
        name: (e as Error)?.name ?? 'error',
        attempt,
      })
      cfg.onFailure?.('ambiguous')
      if (attempt === SEND_ATTEMPTS) return false
    }
    const wait = retryAfterMs > 0 ? retryAfterMs : attempt * 500
    if (wait > MAX_RETRY_WAIT_MS) {
      console.error('[mail] provider asked for a longer wait than a send allows', {
        intent,
        attempt,
      })
      return false
    }
    if (cfg.deadline !== undefined && Date.now() + wait >= cfg.deadline) {
      console.error('[mail] send deadline passed', { intent, attempt })
      return false
    }
    await new Promise<void>((r) => setTimeout(() => r(), wait))
  }
  return false
}

/** Billing reminders use the same transport, but never log recipients/URLs
 * when unconfigured. `attempt` is billingMail.ts's hourly attempt, which
 * picks the idempotency key (noticeKey). */
export async function sendBillingReminder(input: {
  to: string
  url: string
  until: string
  notice_key: string
  attempt: number
}): Promise<boolean> {
  const configured = sender()
  if (configured === null) return false
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
    sender: configured,
    idempotencyKey: await noticeKey(input),
  })
}

export type InviteOutcome = 'sent' | 'unsent' | 'uncertain'

/** Organization invitations (invites.ts), from the operator console and the
 * app, use the same transport and From address. The organization name is stored
 * text, so it appears only in the body, folded to one line, capped and escaped
 * in HTML, never in the subject. A guest invitation ends its sentence with
 * "as a guest". The outcome is 'sent' when the provider accepted the letter,
 * 'uncertain' when the last answer leaves open whether a request delivered it
 * (timeout, network error, conflict, rate limit or server error), and
 * 'unsent' otherwise, that is, when the provider gave a final refusal or a
 * sandbox acceptance, or no request reached it (mail not configured, demo, or
 * the batch deadline passed first).
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
  const configured = sender()
  if (configured === null) return 'unsent'
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
  /* The last answer decides. A final refusal or a sandbox acceptance means no
   * attempt delivered the letter: Lettermint answers a repeat of an accepted
   * request with its 202, and refuses the same body the same way each time. */
  let ambiguous = false
  const ok = await postLetter(letter, 'invite', {
    sender: configured,
    idempotencyKey: await sha256Hex(input.send_key),
    deadline: input.deadline,
    onFailure: (kind) => {
      ambiguous = kind === 'ambiguous'
    },
  })
  return ok ? 'sent' : ambiguous ? 'uncertain' : 'unsent'
}

/** Tells one admin that the organization is read-only and will be deleted.
 * orgRemovals.ts sends it when the read-only period starts and nobody has
 * exported in the week before. The organization name stays in the body,
 * folded and capped as in an invitation. `attempt` is orgRemovals.ts's
 * hourly attempt, which picks the idempotency key (noticeKey). */
export async function sendDeletionNotice(input: {
  to: string
  org_name: string
  delete_after: string
  reason: string
  url: string
  notice_key: string
  attempt: number
}): Promise<boolean> {
  const configured = sender()
  if (configured === null) return false
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
    sender: configured,
    idempotencyKey: await noticeKey(input),
  })
}

// --------------------------------------------------------------- auth mail

/** Sends one authentication letter while its request waits, and says how it
 * went. 'unavailable' means mail is not configured (or this is the demo), so
 * no request reached the provider. Without a token, an explicit local
 * development opt-in logs the link instead and counts as sent. A verify or
 * reset letter's key is its link, which holds a fresh token, and the two
 * account notes get a fresh key each. */
export async function sendAuthLetter(input: {
  intent: AuthLetterIntent
  to: string
  url: string
}): Promise<AuthMailOutcome> {
  const { intent, to, url } = input
  if (process.env.APP_MODE === 'demo') return 'unavailable'
  if (!process.env.LETTERMINT_API_KEY) {
    if (!localAuthEmailLogging()) return 'unavailable'
    console.log(`[mail] local-development intent=${intent} url=${url}`)
    return 'sent'
  }
  const configured = sender()
  if (configured === null) return 'unavailable'
  const linked = intent === 'verify' || intent === 'reset'
  let ambiguous = false
  const ok = await postLetter(AUTH_LETTERS[intent](to, url), intent, {
    sender: configured,
    idempotencyKey: await sha256Hex(linked ? url : `${intent}:${crypto.randomUUID()}`),
    deadline: Date.now() + AUTH_SEND_BUDGET_MS,
    onFailure: (kind) => {
      ambiguous = kind === 'ambiguous'
    },
  })
  return ok ? 'sent' : ambiguous ? 'uncertain' : 'unsent'
}
