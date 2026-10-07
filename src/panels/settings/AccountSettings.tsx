/* Personal profile, appearance, Inbox retention and assistant connections. */
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Avatar, Icon } from '../../components/qivo'
import {
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { UserVM } from '../../store/planner'
import { P } from '../../store/planner'
import { AppearanceSettings } from '../AppearanceSettings'
import { ConnectedApps } from '../ConnectedApps'
import { BackLink, DemoCapabilityNotice } from './controls'
import { AvatarField, NameField } from './ProfileControls'

/* ---------- pages ---------- */
export function AccountPage({
  narrow = false,
  section = '',
  setPage,
  onBackPage = setPage,
}: {
  narrow?: boolean
  section?: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
}) {
  const profile = P.user(P.CURRENT_USER)
  const me: Pick<UserVM, 'id' | 'name' | 'email' | 'orgRole'> = profile ?? {
    id: '',
    name: '',
    email: null,
    orgRole: 'user',
  }
  const sections = [
    { id: 'profile', label: 'Profile', icon: 'user', hint: 'Name, picture and sign out' },
    { id: 'appearance', label: 'Appearance', icon: 'cog', hint: 'Theme and background' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', hint: 'How long to keep read messages' },
    { id: 'mcp', label: 'MCP access', icon: 'command', hint: 'Connect your assistant with OAuth' },
  ]
  const currentSection = sections.find((item) => item.id === section)
  if (narrow && !currentSection) {
    return (
      <>
        <PageTitle>Your preferences</PageTitle>
        <div className="settings-mobile-menu-list">
          {sections.map((item) => (
            <Button
              key={item.id}
              variant="unstyled"
              className="settings-mobile-menu-row"
              data-settings-account-section={item.id}
              onClick={() => setPage(`account-${item.id}`)}
            >
              <Icon name={item.icon} size={20} />
              <span className="settings-mobile-menu-copy">
                <span>{item.label}</span>
                <span>{item.hint}</span>
              </span>
              <Icon name="chevronRight" size={16} />
            </Button>
          ))}
        </div>
      </>
    )
  }
  const showProfile = !narrow || section === 'profile'
  // On a phone each section is a page of its own and its name is the page
  // title, so the sections carry no heading there.
  const heading = (label: string) => (narrow ? undefined : label)
  return (
    <div data-settings-account-detail={narrow ? section : undefined}>
      {narrow && <BackLink to="preferences" onClick={() => onBackPage('account')} />}
      <PageTitle>{narrow ? currentSection?.label : 'Your account'}</PageTitle>
      {showProfile && (
        <SettingsSection title={heading('Profile')}>
          <SettingsField label="Signed in as" width={400}>
            <div className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]">
              <Avatar id={me.id} size={40} />
              <div className="[flex:1] [min-width:0]">
                <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                  {me.name}
                </div>
                <div
                  data-account-email
                  className="[font-size:var(--fs-xs)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
                >
                  {DEMO_MODE ? 'Private demo' : me.email || 'no email address'}
                  {me.orgRole === 'admin' ? ', Admin' : ''}
                </div>
              </div>
              <Button type="button" onClick={() => P.signOut()}>
                {DEMO_MODE ? 'Leave demo' : 'Sign out'}
              </Button>
            </div>
          </SettingsField>
          {profile?.id && (
            <div className="settings-profile-fields grid w-full max-w-[470px] grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-6 [&>.settings-field]:mb-0">
              <AvatarField user={profile} />
              <NameField me={profile} />
            </div>
          )}
        </SettingsSection>
      )}
      {profile?.id && (!narrow || section === 'appearance') && (
        <SettingsSection title={heading('Appearance')}>
          <AppearanceSettings key={profile.id} />
        </SettingsSection>
      )}
      {profile?.id && (!narrow || section === 'inbox') && (
        <SettingsSection title={heading('Inbox')}>
          <RetentionField me={profile} />
        </SettingsSection>
      )}
      {(!narrow || section === 'mcp') && (
        <SettingsSection
          title={heading('MCP access')}
          description={
            DEMO_MODE
              ? undefined
              : 'Connect an AI agent to work in Qivo on your behalf, using your permissions.'
          }
        >
          {DEMO_MODE ? (
            <DemoCapabilityNotice>
              External agent connections and credentials are unavailable in the demo.
            </DemoCapabilityNotice>
          ) : (
            <McpAccessSection />
          )}
        </SettingsSection>
      )}
    </div>
  )
}

// Retention is shared across the account's seats; null in this view means Never.
// Preserve custom values outside the preset choices when rendering the picker.
const days = (n: number) => n + (n === 1 ? ' day' : ' days')

function RetentionField({ me }: { me: Pick<UserVM, 'messageRetentionDays'> }) {
  const cur = me.messageRetentionDays
  const known = cur == null || P.MESSAGE_RETENTION_DAYS.includes(cur)
  return (
    <SettingsField
      label="Remove read messages"
      width={400}
      hint={
        cur == null ? undefined : (
          <>
            The period starts when you read the latest message on a task
            <br />
            Tasks and comments are kept
          </>
        )
      }
    >
      <NativeSelect
        value={cur == null ? 'never' : String(cur)}
        data-message-retention
        aria-label="Remove read messages"
        onChange={(e) => {
          const v = e.target.value === 'never' ? null : Number(e.target.value)
          P.setMessageRetention(v)
          window.showToast?.(
            v == null
              ? 'Read messages are kept until you remove them'
              : `Read messages are removed after ${days(v)}`,
          )
        }}
        className="h-control w-60 bg-surface-1 px-[11px] font-sans text-base"
      >
        {P.MESSAGE_RETENTION_DAYS.map((d: number) => (
          <option key={d} value={d}>
            After {days(d)}
          </option>
        ))}
        {!known && <option value={String(cur)}>After {days(cur)}</option>}
        <option value="never">Never</option>
      </NativeSelect>
    </SettingsField>
  )
}

/* OAuth is the primary connection flow. Personal tokens remain available for
   manual setup; their secrets are shown once and never stored in the browser. */
function McpAccessSection() {
  const [tokens, setTokens] = useStateS<Awaited<ReturnType<typeof P.listMcpTokens>> | false>(null)
  const [name, setName] = useStateS('')
  const [fresh, setFresh] = useStateS<{ name: string; secret: string } | null>(null)
  const [busy, setBusy] = useStateS(false)
  const [confirm, setConfirm] = useStateS<string | null>(null)
  const [copied, setCopied] = useStateS<'server' | 'secret' | 'cmd' | null>(null)
  // Newly minted credentials only exist here until explicitly dismissed.
  useUpdateBlocker(!!name || !!fresh || busy)

  const reload = () => {
    P.listMcpTokens().then((ts) => setTokens(ts === null ? false : ts))
  }
  useEffectS(() => {
    reload()
  }, [])

  const mcpUrl = `${import.meta.env.VITE_CONVEX_SITE_URL}/mcp`
  const claudeCmd = (secret: string) =>
    'claude mcp add --transport http qivo "' +
    mcpUrl +
    '" --header "Authorization: Bearer ' +
    secret +
    '"'
  const copy = (what: 'server' | 'secret' | 'cmd', textToCopy: string) => {
    navigator.clipboard.writeText(textToCopy).then(
      () => setCopied(what),
      () => {},
    )
  }
  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const res = await P.createMcpToken(name.trim())
    setBusy(false)
    if (!res) {
      window.showToast?.("Couldn't create the MCP token")
      return
    }
    setFresh({ name: name.trim(), secret: res.secret })
    setName('')
    setCopied(null)
    reload()
  }

  return (
    <div>
      <SettingsGroup legend="Connect with OAuth" data-mcp-oauth="">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-text-2">
          <li>
            Add this server address in your assistant’s MCP settings.
            <div className="mt-2 flex flex-col items-stretch gap-2 min-[761px]:flex-row min-[761px]:items-center">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text-1">
                {mcpUrl}
              </code>
              <Button
                type="button"
                size="sm"
                aria-label="Copy MCP server address"
                onClick={() => copy('server', mcpUrl)}
              >
                <Icon name={copied === 'server' ? 'check' : 'copy'} size={16} />
                {copied === 'server' ? 'Copied' : 'Copy address'}
              </Button>
            </div>
          </li>
          <li>
            Start the connection from your AI agent. Sign in to Qivo when the sign-in window
            appears, then approve the connection.
          </li>
        </ol>
      </SettingsGroup>
      <ConnectedApps />
      <SettingsGroup legend="Personal access tokens" data-mcp-tokens="">
        <p className="mb-4 text-sm text-text-2">
          Use a permanent token when your client needs one or you want to configure access manually.
          Tokens do not expire automatically; revoke them here when you no longer need them.
        </p>
        {fresh && (
          <div className="[margin-bottom:8px] [border:1px_solid_var(--primary)] [border-radius:var(--r-lg)] [padding:20px] [background:var(--accent-soft)]">
            <div className="[font-size:var(--fs-base)] [font-weight:600] [margin-bottom:8px]">
              “{fresh.name}” created
            </div>
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [margin-bottom:8px]">
              Copy the token now. It cannot be shown again.
            </div>
            <div className="[display:flex] [gap:8px] [align-items:center] [margin-bottom:8px]">
              <code className="[flex:1] !font-mono [font-size:var(--fs-sm)] [padding:7px_9px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-sm)] [overflow-x:auto] [white-space:nowrap]">
                {fresh.secret}
              </code>
              <Button type="button" onClick={() => copy('secret', fresh.secret)}>
                <Icon name={copied === 'secret' ? 'check' : 'copy'} size={16} />
                {copied === 'secret' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="[display:flex] [gap:8px] [align-items:center]">
              <code className="[flex:1] !font-mono [font-size:var(--fs-xs)] [padding:7px_9px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-sm)] [overflow-x:auto] [white-space:nowrap] [color:var(--text-1)]">
                {claudeCmd(fresh.secret)}
              </code>
              <Button
                type="button"
                title="Copy Claude Code setup command"
                onClick={() => copy('cmd', claudeCmd(fresh.secret))}
              >
                <Icon name={copied === 'cmd' ? 'check' : 'copy'} size={16} />
                {copied === 'cmd' ? 'Copied' : 'Claude'}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="[margin-top:8px]"
              onClick={() => setFresh(null)}
            >
              Done
            </Button>
          </div>
        )}

        {tokens === null && (
          <div className="[color:var(--text-2)] [font-size:var(--fs-base)]">Loading…</div>
        )}
        {tokens === false && (
          <div className="[color:var(--danger)] [font-size:var(--fs-base)]">
            Couldn't load MCP tokens.
          </div>
        )}
        {Array.isArray(tokens) && (
          <div className="[display:flex] [flex-direction:column] [gap:6px] mb-6 empty:mb-0">
            {tokens.map((t) => {
              const arm = confirm === t.id
              return (
                <div
                  key={t.id}
                  style={{ opacity: t.revokedAt ? 0.6 : 1 }}
                  className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
                >
                  <Icon name="command" size={16} color="var(--text-2)" />
                  <div className="[flex:1] [min-width:0]">
                    <div className="[font-size:var(--fs-base)] [font-weight:600]">
                      {t.name}
                      {t.revokedAt && (
                        <span className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:700] [color:var(--danger)]">
                          revoked
                        </span>
                      )}
                    </div>
                    <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                      {t.prefix}…, created {P.fmtDate(new Date(t.createdAt))}
                      {t.lastUsedAt
                        ? `, last used ${P.fmtDate(new Date(t.lastUsedAt))}`
                        : ', never used'}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size={arm && t.revokedAt ? 'sm' : 'icon-sm'}
                    style={{ color: arm ? 'var(--danger)' : undefined }}
                    className="[flex-shrink:0]"
                    aria-label={
                      t.revokedAt
                        ? arm
                          ? 'Confirm token deletion'
                          : 'Delete revoked token'
                        : arm
                          ? 'Confirm revocation — connected clients lose access immediately'
                          : 'Revoke this token'
                    }
                    title={
                      t.revokedAt
                        ? arm
                          ? 'Confirm token deletion'
                          : 'Delete revoked token'
                        : arm
                          ? 'Confirm revocation — connected clients lose access immediately'
                          : 'Revoke this token'
                    }
                    onClick={async () => {
                      if (!arm) {
                        setConfirm(t.id)
                        return
                      }
                      setConfirm(null)
                      const ok = t.revokedAt
                        ? await P.deleteMcpToken(t.id)
                        : await P.revokeMcpToken(t.id)
                      window.showToast?.(
                        ok
                          ? t.revokedAt
                            ? 'MCP token deleted'
                            : `“${t.name}” revoked`
                          : "That didn't go through",
                      )
                      reload()
                    }}
                  >
                    <Icon name={t.revokedAt ? 'trash' : 'blocked'} size={16} />
                    {arm && t.revokedAt && 'Delete?'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        {Array.isArray(tokens) && (
          <div className="[display:flex] [gap:8px]">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Token name, e.g. "Claude on my laptop"'
              onKeyDown={(e) => {
                if (e.key === 'Enter') create()
              }}
              className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
            />
            <Button type="button" disabled={!name.trim() || busy} onClick={create}>
              <Icon name="plus" size={16} />
              {busy ? 'Creating…' : 'New token'}
            </Button>
          </div>
        )}
      </SettingsGroup>
      <p className="mt-4 text-sm text-text-2">
        For an agent with its own identity and project access, an organization admin can create an
        agent user in Settings → Organization → Users.
      </p>
    </div>
  )
}
