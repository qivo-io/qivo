/* Personal access tokens on Settings → Your preferences → MCP access. The
   list shows each token's access, expiry and last use. New token opens a
   dialog that asks for a name, access and an optional last day, then shows
   the secret once. The browser mints the secret (P.createMcpToken), and
   nothing keeps it after the dialog closes. Access and expiry are fixed at
   creation; the server alone decides whether a token still works. */
import type { FunctionReturnType } from 'convex/server'
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { api } from '../../../convex/_generated/api'
import { CopyValue } from '../../components/CopyValue'
import { Icon } from '../../components/qivo'
import { SettingsGroup } from '../../components/settingsPage'
import { isoFromDate } from '../../lib/dates'
import { watchLocalDay } from '../../lib/localDay'
import { connectionScopeLabel } from '../../lib/oauthConnection'
import {
  expiryFromDay,
  expiryLabel,
  expiryPhrase,
  isExpired,
  msUntilNextExpiry,
} from '../../lib/tokenExpiry'
import { useConfirmArm } from '../../lib/useConfirmArm'
import { type McpTokenChoice, P } from '../../store/planner'
import { MField, ModalShell } from '../Modals'

type Token = FunctionReturnType<typeof api.tokens.listMcpTokens>[number]

const ACCESS_LABEL: Record<McpTokenChoice['access'], string> = {
  read: 'Read only',
  write: 'Can make changes',
}

/* Column widths, shared by the headings and every row. The columns need
   about 520px, so in a narrower token list (a phone, or a tablet beside the
   settings menu) a container query in styles/mobile-settings.css hides the
   headings and cells and each row's summary line says the same. */
const ACCESS_COL = 'w-[126px]'
const EXPIRES_COL = 'w-[82px]'
const USED_COL = 'w-[60px]'
const HEADING = 'shrink-0 text-xs leading-none font-semibold text-text-2'
const CELL = 'shrink-0 text-sm'

/** The Claude Code command that adds Qivo's MCP server with this secret. */
const claudeCommand = (mcpUrl: string, secret: string) =>
  `claude mcp add --transport http qivo "${mcpUrl}" --header "Authorization: Bearer ${secret}"`

/** The Personal access tokens group: the token list and New token. */
export function PersonalTokens({ mcpUrl }: { mcpUrl: string }) {
  const [tokens, setTokens] = useState<Token[] | false | null>(null)
  const confirm = useConfirmArm<string>()
  const [creating, setCreating] = useState(false)
  // Labels such as "Today" follow the calendar day without a reload.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => watchLocalDay(setNow), [])
  // A token created in another time zone expires during this viewer's day,
  // so the clock also moves when the next listed token expires. The delay is
  // measured from the clock, not from `now`, which can be hours old when the
  // list reloads.
  useEffect(() => {
    if (!Array.isArray(tokens)) return
    const delay = msUntilNextExpiry(tokens, new Date())
    if (delay === null) return
    const timer = setTimeout(() => setNow(new Date()), delay)
    return () => clearTimeout(timer)
  }, [tokens, now])

  // A reload also renews the clock, so the rows it brings are labeled now.
  const reload = () => {
    P.listMcpTokens().then((ts) => {
      setNow(new Date())
      setTokens(ts === null ? false : ts)
    })
  }
  useEffect(() => {
    reload()
  }, [])

  return (
    <SettingsGroup legend="Personal access tokens" data-mcp-tokens="">
      <p className="mb-4 text-sm text-text-2">
        Use a token when your client needs one or you want to configure access manually. Revoke it
        here when you no longer need it.
      </p>
      {tokens === null && (
        <div className="[color:var(--text-2)] [font-size:var(--fs-base)]">Loading…</div>
      )}
      {tokens === false && (
        <div className="[color:var(--danger)] [font-size:var(--fs-base)]">
          Couldn't load MCP tokens.
        </div>
      )}
      {Array.isArray(tokens) && tokens.length > 0 && (
        <div data-mcp-token-list="" className="mb-6 flex flex-col gap-1.5">
          <div
            aria-hidden="true"
            data-mcp-token-columns=""
            className="-mb-0.5 flex items-end gap-2 px-[9px]"
          >
            <div className="min-w-0 flex-1" />
            <div className={cn(HEADING, ACCESS_COL)}>Access</div>
            <div className={cn(HEADING, EXPIRES_COL)}>Expires</div>
            <div className={cn(HEADING, USED_COL)}>Last used</div>
            <div className="w-control-sm shrink-0" />
          </div>
          {tokens.map((t) => (
            <TokenRow
              key={t.id}
              token={t}
              now={now}
              armed={confirm.armed === t.id}
              onPress={(action) => confirm.press(t.id, action)}
              onChanged={reload}
            />
          ))}
        </div>
      )}
      {Array.isArray(tokens) && (
        <Button
          type="button"
          data-mcp-new-token=""
          onClick={() => {
            // an armed Delete or Revoke must not survive a trip through the dialog
            confirm.disarm()
            setCreating(true)
          }}
        >
          <Icon name="plus" size={16} />
          New token
        </Button>
      )}
      {creating && (
        <NewTokenDialog mcpUrl={mcpUrl} onCreated={reload} onClose={() => setCreating(false)} />
      )}
    </SettingsGroup>
  )
}

/* One token. A revoked or expired token is dimmed and offers Delete, an
   active one Revoke; both take a second click to confirm, which turns the
   icon red. A token an organization admin revoked on API access says so.
   The button stays icon-sized when armed, so the cells stay under their
   headings. */
function TokenRow({
  token: t,
  now,
  armed,
  onPress,
  onChanged,
}: {
  token: Token
  now: Date
  armed: boolean
  // the list's useConfirmArm press for this row, which arms it or runs `action`
  onPress: (action: () => void) => void
  onChanged: () => void
}) {
  const revoked = !!t.revokedAt
  const expired = !revoked && isExpired(t.expiresAt, now)
  const ended = revoked || expired
  const expiry = expiryLabel(t.expiresAt, now)
  const lastUsed = t.lastUsedAt ? P.fmtDate(new Date(t.lastUsedAt)) : null
  const summary = [
    { text: ACCESS_LABEL[t.access], soon: false },
    ...(revoked ? [] : [{ text: expiryPhrase(t.expiresAt, now), soon: expiry.soon }]),
    { text: lastUsed ? `last used ${lastUsed}` : 'never used', soon: false },
  ]
  const action = ended
    ? armed
      ? 'Confirm token deletion'
      : `Delete ${revoked ? 'revoked' : 'expired'} token`
    : armed
      ? 'Confirm revocation. Connected clients lose access immediately'
      : 'Revoke this token'
  return (
    <div
      data-mcp-token={t.id}
      className={cn(
        '[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]',
        ended && 'opacity-60',
      )}
    >
      <Icon name="command" size={16} color="var(--text-2)" />
      <div className="[flex:1] [min-width:0]">
        <div className="[font-size:var(--fs-base)] [font-weight:600]">
          {t.name}
          {ended && (
            <span className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:700] [color:var(--danger)]">
              {revoked ? (t.revokedByAdmin ? 'revoked by an admin' : 'revoked') : 'expired'}
            </span>
          )}
        </div>
        <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
          {t.prefix}…, created {P.fmtDate(new Date(t.createdAt))}
        </div>
        {/* the phone's stand-in for the columns; each fact wraps whole */}
        <div data-mcp-token-summary="" className="text-xs text-text-2">
          {summary.map((part, i) => (
            <Fragment key={part.text}>
              {i > 0 && ', '}
              <span className={cn('whitespace-nowrap', part.soon && 'text-warning')}>
                {part.text}
              </span>
            </Fragment>
          ))}
        </div>
      </div>
      <div data-mcp-token-cell="access" className={cn(CELL, ACCESS_COL)}>
        <span className="sr-only">Access </span>
        {ACCESS_LABEL[t.access]}
      </div>
      <div
        data-mcp-token-cell="expires"
        className={cn(CELL, EXPIRES_COL, expiry.soon && 'text-warning')}
      >
        {!revoked && (
          <>
            <span className="sr-only">Expires </span>
            {expiry.text}
          </>
        )}
      </div>
      <div data-mcp-token-cell="used" className={cn(CELL, USED_COL, 'text-text-2')}>
        <span className="sr-only">Last used </span>
        {lastUsed ?? 'Never'}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn('[flex-shrink:0]', armed && 'text-danger')}
        aria-label={action}
        title={action}
        onClick={() => {
          // press disarms before the request, so a click while it runs arms
          // the button again instead of sending it twice
          onPress(async () => {
            const ok = ended ? await P.deleteMcpToken(t.id) : await P.revokeMcpToken(t.id)
            if (ok) window.showToast?.(ended ? 'MCP token deleted' : `“${t.name}” revoked`)
            else window.showToast?.("That didn't go through", 'error')
            onChanged()
          })
        }}
      >
        <Icon name={ended ? 'trash' : 'blocked'} size={16} />
      </Button>
    </div>
  )
}

/** The New token dialog. Step one asks for a name, access (changes allowed
    by default) and an expiry, Never or a last day. Step two shows the secret
    once, and only Close, Escape or Done dismiss it, never a click outside.
    The parent mounts it only while open, so closing resets it. ModalShell
    blocks app updates for as long as it is mounted, which covers the typed
    name, the create call and the shown secret. */
export function NewTokenDialog({
  mcpUrl,
  onCreated,
  onClose,
}: {
  mcpUrl: string
  onCreated: () => void
  onClose: () => void
}) {
  const id = useId()
  const [name, setName] = useState('')
  const [allowChanges, setAllowChanges] = useState(true)
  const [expires, setExpires] = useState<'never' | 'on'>('never')
  const [day, setDay] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{
    name: string
    secret: string
    choice: McpTokenChoice
  } | null>(null)
  const now = new Date()
  // undefined means never; null means On without a usable day
  const expiresAt = expires === 'on' ? expiryFromDay(day, now) : undefined
  const canCreate = !!name.trim() && !busy && expiresAt !== null

  const create = async () => {
    if (!name.trim() || busy || expiresAt === null) return
    // a paused create keeps the dialog and says why
    if (P.refusePausedEdit()) return
    const choice: McpTokenChoice = { access: allowChanges ? 'write' : 'read', expiresAt }
    setBusy(true)
    const res = await P.createMcpToken(name.trim(), choice)
    setBusy(false)
    if (!res) {
      window.showToast?.("Couldn't create the MCP token", 'error')
      return
    }
    setCreated({ name: name.trim(), secret: res.secret, choice })
    onCreated()
  }
  // A token being created must reach step two, or its secret is lost, so a
  // close while busy is refused (false keeps a phone's Back step too).
  const close = () => {
    if (busy) return false
    onClose()
  }
  // Step two replaces the field that held focus, so focus would fall back to
  // the dialog itself. Hand it to the token's copy button, the next thing to
  // do, so keyboard and screen reader users land on the secret.
  const shown = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (created) shown.current?.querySelector<HTMLElement>('[data-fresh-token]')?.focus()
  }, [created])

  if (created) {
    return (
      <ModalShell
        icon="command"
        title="Token created"
        onClose={close}
        width={520}
        keepOnOutsideClick
        footer={
          <>
            <div className="min-w-0 flex-1" />
            <Button type="button" variant="primary" className="font-semibold" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <div ref={shown} data-new-mcp-token="created">
          <div className="text-base font-semibold">{created.name}</div>
          <div data-new-mcp-token-summary="" className="mt-0.5 mb-4 text-sm text-text-1">
            {ACCESS_LABEL[created.choice.access]},{' '}
            {expiryPhrase(created.choice.expiresAt ?? null, now)}
          </div>
          <div className="text-sm text-text-2">Copy the token now. It cannot be shown again.</div>
          <div className="mt-1">
            <CopyValue value={created.secret} label="Copy token" data-fresh-token="" />
          </div>
          <div className="mt-3 text-sm text-text-2">Claude Code setup command</div>
          <div className="mt-1">
            <CopyValue
              value={claudeCommand(mcpUrl, created.secret)}
              label="Copy Claude Code setup command"
              data-fresh-token-command=""
            />
          </div>
        </div>
      </ModalShell>
    )
  }

  return (
    <ModalShell
      icon="command"
      title="New token"
      onClose={close}
      onSubmit={() => void create()}
      canSubmit={canCreate}
      submitLabel={busy ? 'Creating…' : 'Create token'}
      width={520}
    >
      <div data-new-mcp-token="form">
        <MField label="Name">
          <Input
            aria-label="Name"
            data-autofocus=""
            value={name}
            maxLength={P.NAME_MAX}
            placeholder="e.g. Claude on my laptop"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // The Enter that confirms an IME candidate must not create the
              // token. Safari clears isComposing first but keeps keyCode 229.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229)
                void create()
            }}
            className="h-control w-full bg-surface-1 font-sans text-base"
          />
        </MField>
        <MField label="Access" role="group" aria-label="Access">
          <ul className="mb-3 list-disc pl-5 text-sm text-text-2">
            <li>{connectionScopeLabel('qivo:read')}</li>
          </ul>
          <div className="flex items-start gap-3">
            <Checkbox
              id={`${id}-changes`}
              checked={allowChanges}
              data-new-mcp-token-changes=""
              onCheckedChange={(checked) => setAllowChanges(checked === true)}
            />
            <div>
              <Label htmlFor={`${id}-changes`}>Allow changes</Label>
              <p className="mt-1 text-sm text-text-2">{connectionScopeLabel('qivo:write')}</p>
            </div>
          </div>
        </MField>
        <MField label="Expires" role="radiogroup" aria-label="Expires">
          <div className="flex flex-col gap-2">
            <Label className="flex min-h-8 items-center gap-2 text-sm">
              <Input
                type="radio"
                name={`${id}-expires`}
                value="never"
                checked={expires === 'never'}
                data-new-mcp-token-expires="never"
                onChange={() => setExpires('never')}
              />
              Never
            </Label>
            <div className="flex items-center gap-2">
              <Label className="flex min-h-8 items-center gap-2 text-sm">
                <Input
                  type="radio"
                  name={`${id}-expires`}
                  value="on"
                  checked={expires === 'on'}
                  data-new-mcp-token-expires="on"
                  onChange={() => setExpires('on')}
                />
                On
              </Label>
              <Input
                type="date"
                aria-label="Expires on"
                min={isoFromDate(now)}
                value={day}
                data-new-mcp-token-day=""
                onChange={(e) => {
                  setDay(e.target.value)
                  if (e.target.value) setExpires('on')
                }}
                className="h-control w-[150px] bg-surface-1 font-sans text-base"
              />
            </div>
          </div>
        </MField>
        <p className="text-sm text-text-2">
          You cannot change access or expiry after you create the token.
        </p>
      </div>
    </ModalShell>
  )
}
