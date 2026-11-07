/* Personal access tokens on Settings → Your preferences → MCP access. The
   list shows each token's access, expiry and last use, newest first, 25 a
   batch from the server (tokens.personalTokens) with Load more, read once
   a batch through the shared paged list's `once` source (lib/pagedList.ts)
   and never subscribed, since every call made with a token stamps its last
   use. A search over the whole list, by name or by the start of the token
   the row shows, appears once a list without a search has more than one
   batch in this visit, or while it holds text. A create, revoke or delete
   reads the list again from its first batch with its search kept, while
   the rows it holds stay on screen; past TOKEN_LIST.most rows the list
   asks for a search, and leaving the page drops every row. New token opens
   a dialog that asks for a name, access and an optional last day, then
   shows the secret once. The browser mints the secret (P.createMcpToken),
   and nothing keeps it after the dialog closes. Access and expiry are fixed
   at creation; the server alone decides whether a token still works. */
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../../convex/lib/limits'
import { CopyValue } from '../../components/CopyValue'
import { LimitedInput } from '../../components/LimitedField'
import { Icon } from '../../components/qivo'
import { SettingsGroup } from '../../components/settingsPage'
import { TOKEN_LIST } from '../../lib/credentialLists'
import { isoFromDate } from '../../lib/dates'
import { limitSentence, overLimit } from '../../lib/fieldLimits'
import { focusAround, useFocusWhenGone } from '../../lib/focusWhenGone'
import { watchLocalDay } from '../../lib/localDay'
import { connectionScopeLabel } from '../../lib/oauthConnection'
import { type ListEnd, listEnd, usePagedList, useSettledSearch } from '../../lib/pagedList'
import {
  expiryFromDay,
  expiryLabel,
  expiryPhrase,
  isExpired,
  msUntilNextExpiry,
} from '../../lib/tokenExpiry'
import { useConfirmArm } from '../../lib/useConfirmArm'
import { type McpTokenChoice, P, type PersonalTokenBatch } from '../../store/planner'
import { MField, ModalShell } from '../Modals'

/** One token as the list shows it (tokens.personalTokens). */
type Token = PersonalTokenBatch['rows'][number]

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
const noteClass = 'px-0.5 py-1 text-sm text-text-2'

/** The Claude Code command that adds Qivo's MCP server with this secret. */
const claudeCommand = (mcpUrl: string, secret: string) =>
  `claude mcp add --transport http qivo "${mcpUrl}" --header "Authorization: Bearer ${secret}"`

const tokenId = (t: Token) => t.id
/** The button of the token row with id `id`, its revoke or delete. */
const rowButton = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-mcp-token]')]
    .find((row) => row.dataset.mcpToken === id)
    ?.querySelector<HTMLElement>('button') ?? null
const newTokenButton = () => document.querySelector<HTMLElement>('[data-mcp-new-token]')

/** The Personal access tokens group: the search, the token list with its
    end line, and New token. */
export function PersonalTokens({ mcpUrl }: { mcpUrl: string }) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = JSON.stringify([search.settled])
  const list = usePagedList({
    key,
    source: { kind: 'once', read: (at) => P.personalTokens(search.settled, at.after) },
    batch: (answer: PersonalTokenBatch) => answer,
    id: tokenId,
    most: TOKEN_LIST.most,
  })
  const end: ListEnd | 'too_long' = search.tooLong
    ? 'too_long'
    : listEnd(list, search.settled !== '')
  // The search shows once the list without a search answered more than
  // one batch's worth in this visit, and stays for the rest of it.
  const [searchShown, setSearchShown] = useState(false)
  const showSearch = searchShown || text !== '' || (search.settled === '' && list.next)
  useEffect(() => {
    if (showSearch) setSearchShown(true)
  }, [showSearch])
  const confirm = useConfirmArm<string>()
  const [creating, setCreating] = useState(false)
  // Labels such as "Today" follow the calendar day without a reload.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => watchLocalDay(setNow), [])
  // A batch that lands renews the clock, so the rows it brings are labeled
  // now. The last answer is the same object until another batch lands.
  const lastAnswer = list.answers.at(-1)
  useEffect(() => {
    if (lastAnswer !== undefined) setNow(new Date())
  }, [lastAnswer])
  // A token created in another time zone expires during this viewer's day,
  // so the clock also moves when the next listed token expires. The delay is
  // measured from the clock, not from `now`, which can be hours old when the
  // list reads again.
  useEffect(() => {
    const delay = msUntilNextExpiry(list.rows, new Date())
    if (delay === null) return
    const timer = setTimeout(() => setNow(new Date()), delay)
    return () => clearTimeout(timer)
  }, [lastAnswer, list.answers.length, now])
  /* The token whose Delete or Revoke was confirmed last, with where focus
     goes once its row has left: the next row's button, the previous row's,
     or New token. A revoked token keeps its row and its button keeps focus
     through the list's refresh, unless it sat past the first batch. */
  const [acted, setActed] = useState<{ id: string; focus: () => HTMLElement | null }>()
  useFocusWhenGone(
    !!acted && list.rows.some((t) => t.id === acted.id),
    () => acted?.focus() ?? null,
  )
  // A refresh that failed took every row away; focus goes to its Retry.
  const endLine = useRef<HTMLDivElement>(null)
  useFocusWhenGone(list.rows.length > 0, () =>
    end === 'failed'
      ? (endLine.current?.querySelector<HTMLElement>('[data-mcp-tokens-retry]') ?? null)
      : null,
  )
  // Load more keeps focus while it reads, and its Retry is the same button;
  // once it goes, focus moves to the first new row's button, else to the
  // search or New token. A first batch's Retry that goes moves focus to the
  // search, else the first row's button, else New token.
  const searchBox = useRef<HTMLInputElement>(null)
  const moreFrom = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = moreFrom.current === null ? undefined : list.rows[moreFrom.current]
    return (row ? rowButton(row.id) : null) ?? searchBox.current ?? newTokenButton()
  })
  const more = () => {
    if (list.phase === 'more' || list.refreshing) return
    moreFrom.current = list.rows.length
    list.more()
  }
  const retried = useRef<string | null>(null)
  useFocusWhenGone(end === 'failed' && list.batches.length === 0, () =>
    retried.current === key
      ? (searchBox.current ??
        (list.rows[0] ? rowButton(list.rows[0].id) : null) ??
        newTokenButton())
      : null,
  )
  const retry = () => {
    retried.current = list.batches.length === 0 ? key : null
    list.retry()
  }
  const refresh = () => void list.refresh()
  const loaded = list.answers.length > 0 || list.refreshing

  return (
    <SettingsGroup legend="Personal access tokens" data-mcp-tokens="">
      <p className="mb-4 text-sm text-text-2">
        Use a token when your client needs one or you want to configure access manually. Revoke it
        here when you no longer need it.
      </p>
      {showSearch && (
        <LimitedInput
          ref={searchBox}
          limit={LIMITS.search}
          aria-label="Search tokens"
          data-mcp-tokens-search=""
          placeholder="Search tokens"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears a typed search first
            if (e.key === 'Escape' && text) {
              e.stopPropagation()
              setText('')
            }
          }}
          wrapperClassName="mb-3"
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans"
        />
      )}
      <div
        ref={endLine}
        data-mcp-tokens-end={end}
        aria-busy={end === 'loading' || list.phase === 'more' || list.refreshing || undefined}
        className={cn(loaded && 'mb-6')}
      >
        {list.rows.length > 0 && (
          <div data-mcp-token-list="" className="flex flex-col gap-1.5">
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
            {list.rows.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                now={now}
                armed={confirm.armed === t.id}
                onPress={(action) =>
                  confirm.press(t.id, () => {
                    setActed({
                      id: t.id,
                      focus: focusAround(
                        'data-mcp-token',
                        t.id,
                        (row) => row.querySelector<HTMLElement>('button'),
                        newTokenButton,
                      ),
                    })
                    action()
                  })
                }
                onChanged={refresh}
              />
            ))}
          </div>
        )}
        <TokensEnd
          end={end}
          stopped={list.stopped}
          none={list.rows.length === 0}
          first={list.batches.length === 0}
          loading={list.phase === 'more'}
          refreshing={list.refreshing}
          onMore={more}
          onRetry={retry}
        />
      </div>
      {loaded && (
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
        <NewTokenDialog mcpUrl={mcpUrl} onCreated={refresh} onClose={() => setCreating(false)} />
      )}
    </SettingsGroup>
  )
}

/* The line that ends the token list (lib/pagedList.ts listEnd), with its
   Load more and Retry. The failure's Retry is the same button as Load
   more, in the same place, so focus stays on it when a Load more fails.
   While a refresh reads, Load more stays but reads nothing. The end of a
   list without a search says nothing, as an empty list says nothing. */
function TokensEnd({
  end,
  stopped,
  none,
  first,
  loading,
  refreshing,
  onMore,
  onRetry,
}: {
  end: ListEnd | 'too_long'
  stopped: boolean
  /** whether no loaded batch holds a row */
  none: boolean
  /** whether no batch answered yet, so a failure is the list's, not a
      Load more's */
  first: boolean
  /** whether a Load more is on its way */
  loading: boolean
  /** whether the list reads its first batch again */
  refreshing: boolean
  onMore: () => void
  onRetry: () => void
}) {
  const busy = loading || refreshing
  const line = (text: string, status = false) => (
    <p data-mcp-tokens-note={end} role={status ? 'status' : undefined} className={noteClass}>
      {text}
    </p>
  )
  const button = (label: string, onClick: () => void, more = false) => (
    <Button
      type="button"
      variant="ghost"
      data-mcp-tokens-more={more ? '' : undefined}
      data-mcp-tokens-retry={more ? undefined : ''}
      aria-disabled={busy || undefined}
      onClick={() => !busy && onClick()}
      className="h-control-sm text-sm"
    >
      {label}
    </Button>
  )
  switch (end) {
    case 'too_long':
      return line(limitSentence(LIMITS.search))
    case 'loading':
      return line('Loading…', true)
    case 'failed':
      return (
        <div
          role="alert"
          data-mcp-tokens-note={end}
          className="flex flex-wrap items-center gap-2 px-0.5 py-1 text-sm text-danger"
        >
          {first ? "Couldn't load MCP tokens." : "Couldn't load more tokens."}
          {button('Retry', onRetry)}
        </div>
      )
    case 'full':
      return line('Search to find more tokens.')
    case 'more':
      return (
        <div data-mcp-tokens-note={end} className="mt-1 flex flex-col items-start gap-1">
          {stopped && (
            <p className={noteClass}>
              {none
                ? 'Qivo checked part of the list and found no matches there. Load more continues.'
                : 'Qivo checked part of the list. Load more continues.'}
            </p>
          )}
          {button(loading ? 'Loading…' : 'Load more', onMore, true)}
        </div>
      )
    case 'none':
      return line('No tokens match.')
    case 'held':
    case 'partial':
    case 'end':
      return null
  }
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
        <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow-wrap:anywhere]">
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
  const canCreate =
    !!name.trim() && !overLimit(LIMITS.tokenName, name) && !busy && expiresAt !== null

  const create = async () => {
    if (!canCreate) return
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
      busy={busy}
      unsent={[!!name.trim() && 'token name']}
      onSubmit={() => void create()}
      canSubmit={canCreate}
      submitLabel={busy ? 'Creating…' : 'Create token'}
      width={520}
    >
      <div data-new-mcp-token="form">
        <MField label="Name">
          <LimitedInput
            limit={LIMITS.tokenName}
            aria-label="Name"
            data-autofocus=""
            value={name}
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
