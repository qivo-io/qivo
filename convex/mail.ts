/* Qivo's outbound mail — the AgentMail transport for Better Auth's two
 * letters, and nothing else.
 *
 * Scheduled by createAuth's sendVerificationEmail / sendResetPassword
 * (auth.ts): intents are `verify` and `reset` ONLY. The former
 * `invitation` / `request_to_join` intents are CUT with their feature,
 * and with them everything org-shaped send-mail carried —
 * recipient lookup, runAs authorization, NO_SUCH, the daily budget, the
 * fan-out cap, the shared handler deadline, the {sent:false} envelope. What
 * remains is the provider call itself, ported nearly verbatim: nothing awaits
 * this internalAction (scheduler.runAfter(0)), and a Convex action gets
 * minutes, so the worst case — three attempts at 10 s plus backoffs — needs
 * no deadline.
 *
 * SECRETS. AGENTMAIL_API_KEY / AGENTMAIL_INBOX / AGENTMAIL_BASE_URL are
 * Convex deployment env vars, never VITE_-prefixed (nothing under src/ can
 * reach them), never logged, never echoed. A failed fetch stringifies WITH
 * THE URL, and the URL carries the inbox address — so the provider call has
 * its own catch that records only the error's NAME. Logs carry no key, no
 * inbox, no URL, no recipient.
 *
 * URL LOGGING IS FALLBACK-ONLY. Without a key, sign-up dead-ends unless the
 * verification link is retrievable from `npx convex logs` — so the no-key
 * path logs it as a dev fallback. With a key set, reset/verify URLs
 * are live credentials and must NOT reach the deployment log: the send path
 * logs intent + attempt outcomes only. */

import { v } from 'convex/values'
import { internalAction } from './_generated/server'

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

/* The host is `api.agentmail.to`, NOT the EU host. A key is issued against a
 * region and the host follows the KEY, not the operator's address — the real
 * key answered 403 {"message":"Forbidden"} against .eu and 200 against .to
 * (verified 2026-08-12 by listing inboxes on both). Do not "fix" a 403 by
 * flipping this to EU; check the key's region instead. The env override stays
 * so a reissued key in another region is a secret to flip, not a redeploy.
 * The `/v0` path prefix is what the OpenAPI document and generated client
 * carry (the Quickstart's curl omits it and both forms route). */
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

/* No reply_to on either: there is no human behind a verification or reset
 * mail to reach. The From IS the inbox — AgentMail has no `from` field. */

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

/* One letter, up to three attempts, nothing thrown — send-mail's postLetter,
 * minus the shared deadline (see header).
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
  cfg: { key: string; inbox: string; idempotencyKey: string },
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
    subject: letter.subject,
    text: letter.text,
    html: letter.html,
  })
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    let retryAfterMs = 0
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': cfg.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (res.ok) {
        const ok = (await res.json().catch(() => null)) as { message_id?: string } | null
        // ids only — no address, no subject
        console.log('[mail] sent', { intent, message_id: ok?.message_id ?? null })
        return true
      }
      const detail = (await res.json().catch(() => null)) as { code?: unknown } | null
      const code = typeof detail?.code === 'string' ? detail.code : null
      const retryable =
        res.status === 408 ||
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 409 && attempt === 1)
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
      if (attempt === SEND_ATTEMPTS) return false
    }
    const wait = retryAfterMs > 0 ? retryAfterMs : attempt * 500
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
    ? `Your complimentary Qivo access ended on ${date}. Your organization is read-only until an administrator subscribes. Your existing work is preserved.`
    : `Your complimentary Qivo access ends on ${date}. No card is on file for this free access, and you will not be charged automatically. You can subscribe in Billing when the free period ends.`
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

// ------------------------------------------------------------------- action

export const send = internalAction({
  args: {
    to: v.string(),
    intent: v.union(v.literal('verify'), v.literal('reset')),
    url: v.string(),
  },
  handler: async (_ctx, { to, intent, url }) => {
    if (process.env.APP_MODE === 'demo') return
    const key = process.env.AGENTMAIL_API_KEY
    if (key === undefined || key === '') {
      /* Dev fallback — the ONLY branch where the URL may reach the logs:
       * without a mailer, sign-up dead-ends unless this line is retrievable
       * from `npx convex logs`. */
      console.log(`[mail] intent=${intent} to=${to} url=${url}`)
      return
    }
    const inbox = process.env.AGENTMAIL_INBOX
    if (inbox === undefined || inbox === '') {
      // the NAME, never a value — and never the URL: with a key set, the URL
      // is a live credential and stays out of the deployment log
      console.error('[mail] missing AGENTMAIL_INBOX — cannot send', { intent })
      return
    }
    const letter = intent === 'verify' ? verifyLetter(to, url) : resetLetter(to, url)
    await postLetter(letter, intent, { key, inbox, idempotencyKey: await sha256Hex(url) })
  },
})
