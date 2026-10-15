/* Personal profile, appearance, Inbox retention and assistant connections. */
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { CopyValue } from '../../components/CopyValue'
import { Avatar, Icon } from '../../components/qivo'
import {
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import type { UserVM } from '../../store/planner'
import { P } from '../../store/planner'
import { AppearanceSettings } from '../AppearanceSettings'
import { ConnectedApps } from '../ConnectedApps'
import { BackLink, DemoCapabilityNotice } from './controls'
import { PersonalTokens } from './PersonalTokens'
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
        className="h-control w-60 bg-surface-1 font-sans text-base"
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
   manual setup (PersonalTokens). */
function McpAccessSection() {
  const mcpUrl = `${import.meta.env.VITE_CONVEX_SITE_URL}/mcp`
  return (
    <div>
      <SettingsGroup legend="Connect with OAuth" data-mcp-oauth="">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-text-2">
          <li>
            Add this server address in your assistant’s MCP settings.
            <div className="mt-1">
              <CopyValue value={mcpUrl} label="Copy address" data-mcp-server-address="" />
            </div>
          </li>
          <li>
            Start the connection from your AI agent. Sign in to Qivo when the sign-in window
            appears, then approve the connection.
          </li>
        </ol>
      </SettingsGroup>
      <ConnectedApps />
      <PersonalTokens mcpUrl={mcpUrl} />
      <p className="mt-4 text-sm text-text-2">
        For an agent with its own identity and project access, an organization admin can create an
        agent user in Settings → Organization → Users.
      </p>
    </div>
  )
}
