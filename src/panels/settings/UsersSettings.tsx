/* Organization people, agents, guests and one-time agent credentials. */
import React, { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Avatar, Icon } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsGroup, SettingsSection } from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { NewUserInput, UserVM } from '../../store/planner'
import { P } from '../../store/planner'
import { BackLink, DemoCapabilityNotice } from './controls'
import { AvatarPicker } from './ProfileControls'
import { PlannableHoursInput, UserEmail, UserName, UserRoleSelect } from './UserControls'

const agentKeyFingerprint = (stored: string) =>
  stored.includes('...') || stored.includes('…') ? stored : `${stored}…`

/* One agent's keys, opened from its row. A key is the agent's login, so this
   is the closest thing the app has to a password field — and the secret is
   shown exactly once, at creation, because only its SHA-256 and safe display
   fingerprint are stored. */
function AgentKeyPanel({
  agent,
  keys,
  reload,
}: {
  agent: UserVM
  keys: Awaited<ReturnType<typeof P.listAgentKeys>>
  reload: () => void
}) {
  const [name, setName] = useStateS('')
  const [fresh, setFresh] = useStateS<{ secret: string } | null>(null)
  const [copied, setCopied] = useStateS(false)
  const [busy, setBusy] = useStateS(false)
  const [confirm, setConfirm] = useStateS<string | null>(null)
  useUpdateBlocker(!!name || !!fresh || busy)
  const mine = (keys || []).filter((k) => k.agentId === agent.id)
  const mint = async () => {
    if (busy) return
    setBusy(true)
    const res = await P.createAgentKey(agent.id, name.trim() || 'Key')
    setBusy(false)
    if (!res) {
      window.showToast?.("Couldn't create that key")
      return
    }
    setFresh({ secret: res.secret })
    setCopied(false)
    setName('')
    reload()
  }
  return (
    <div
      data-agent-keys={agent.id}
      className="[margin:0_0_6px_38px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-2)]"
    >
      {fresh && (
        <div className="[margin-bottom:8px] [border:1px_solid_var(--primary)] [border-radius:var(--r-md)] [padding:20px] [background:var(--accent-soft)]">
          <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [margin-bottom:8px]">
            Copy this key now. It cannot be shown again.
          </div>
          <div className="[display:flex] [gap:8px] [align-items:center]">
            <code
              data-fresh-key
              className="[flex:1] !font-mono [font-size:var(--fs-sm)] [padding:7px_9px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-sm)] [overflow-x:auto] [white-space:nowrap]"
            >
              {fresh.secret}
            </code>
            <Button
              type="button"
              onClick={() =>
                navigator.clipboard.writeText(fresh.secret).then(
                  () => setCopied(true),
                  () => {},
                )
              }
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      <div className="[display:flex] [flex-direction:column] [gap:8px] mb-6">
        {mine.length === 0 && (
          <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
            No keys — this agent cannot sign in until it has one.
          </div>
        )}
        {mine.map((k) => {
          const arm = confirm === k.id
          return (
            <div
              key={k.id}
              style={{ opacity: k.revokedAt ? 0.55 : 1 }}
              className="[display:flex] [align-items:center] [gap:8px]"
            >
              <Icon name="zap" size={16} color="var(--text-2)" />
              <div className="[flex:1] [min-width:0]">
                <div className="[font-size:var(--fs-sm)] [font-weight:600]">
                  {k.name}
                  {k.revokedAt && (
                    <span className="[margin-left:6px] [font-size:var(--fs-xs)] [font-weight:700] [color:var(--danger)]">
                      revoked
                    </span>
                  )}
                </div>
                <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                  {agentKeyFingerprint(k.prefix)}, created {P.fmtDate(new Date(k.createdAt))}
                  {k.lastUsedAt
                    ? `, last used ${P.fmtDate(new Date(k.lastUsedAt))}`
                    : ', never used'}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size={arm && k.revokedAt ? 'sm' : 'icon-sm'}
                style={{ color: arm ? 'var(--danger)' : undefined }}
                className="[flex-shrink:0]"
                aria-label={
                  k.revokedAt
                    ? arm
                      ? 'Confirm key deletion'
                      : 'Delete this revoked key'
                    : arm
                      ? 'Confirm revocation — this key loses access immediately'
                      : 'Revoke this key'
                }
                title={
                  k.revokedAt
                    ? arm
                      ? 'Confirm key deletion'
                      : 'Delete this revoked key'
                    : arm
                      ? 'Confirm revocation — this key loses access immediately'
                      : 'Revoke this key'
                }
                onClick={async () => {
                  if (!arm) {
                    setConfirm(k.id)
                    return
                  }
                  setConfirm(null)
                  const ok = k.revokedAt
                    ? await P.deleteAgentKey(k.id)
                    : await P.revokeAgentKey(k.id)
                  window.showToast?.(
                    ok
                      ? k.revokedAt
                        ? 'Key deleted'
                        : `“${k.name}” revoked`
                      : "That didn't go through",
                  )
                  reload()
                }}
              >
                <Icon name={k.revokedAt ? 'trash' : 'blocked'} size={16} />
                {arm && k.revokedAt && 'Delete?'}
              </Button>
            </div>
          )
        })}
      </div>
      <div className="[display:flex] [gap:8px] [align-items:center]">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. CI runner"
          onKeyDown={(e) => {
            if (e.key === 'Enter') mint()
          }}
          className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1] [font-size:var(--fs-sm)]"
        />
        <Button type="button" data-new-agent-key={agent.id} disabled={busy} onClick={mint}>
          <Icon name="plus" size={16} />
          New key
        </Button>
      </div>
    </div>
  )
}

export function OrgUsersPage({
  narrow = false,
  userId,
  setPage,
  onBackPage = setPage,
}: {
  narrow?: boolean
  userId?: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
}) {
  const [addName, setAddName] = useStateS('')
  const [addEmail, setAddEmail] = useStateS('')
  const [addRole, setAddRole] = useStateS<NewUserInput['orgRole']>('user')
  const [addKind, setAddKind] = useStateS<NewUserInput['kind']>('person')
  const [confirm, setConfirm] = useStateS<string | null>(null)
  const [keys, setKeys] = useStateS<Awaited<ReturnType<typeof P.listAgentKeys>>>(null)
  const [openKeys, setOpenKeys] = useStateS<string | null>(null)
  const [freshAgent, setFreshAgent] = useStateS<{ name: string; secret: string } | null>(null)
  useUpdateBlocker(!!addName || !!addEmail || addRole !== 'user' || !!freshAgent)
  const [copied, setCopied] = useStateS(false)
  // the roster is the HOME organization's users; the blended snapshot also
  // holds foreign profiles (mine, in orgs that shared a project with me) and
  // this organization's own guests, both listed elsewhere
  const roster = P.homeUsers()
  const mobileUser = narrow ? roster.find((user) => user.id === userId) : undefined
  const guests = P.homeGuests()
  // "the last admin" is the last one who can still sign in and fix things
  const admins = roster.filter((u) => u.orgRole === 'admin' && u.active)

  const reloadKeys = () => {
    if (DEMO_MODE) {
      setKeys([])
      return
    }
    P.listAgentKeys().then((ks) => setKeys(ks === null ? [] : ks))
  }
  useEffectS(() => {
    reloadKeys()
  }, [])
  const agentMode = addKind === 'agent'
  // People need a claimable email: empty disables Add, malformed also marks
  // the field invalid. Agents have no email, so both checks must be bypassed.
  const emailMissing = !agentMode && !addEmail.trim()
  const emailBad = !agentMode && !emailMissing && !P.emailLooksValid(addEmail)
  const addUser = async () => {
    if (!addName.trim() || emailBad || emailMissing) return
    // Preserve the entered fields when addUser refuses a duplicate seat.
    const added = P.addUser(
      agentMode
        ? { name: addName.trim(), kind: 'agent', orgRole: addRole }
        : { name: addName.trim(), email: addEmail, orgRole: addRole },
    )
    if (!added) return
    const name = addName.trim()
    setAddName('')
    setAddEmail('')
    setAddRole('user')
    if (!agentMode) {
      window.showToast?.(`${name} added to the organization`)
      return
    }
    // An agent with no key cannot sign in, so creating one is a single act:
    // the agent AND the key it authenticates with, revealed once, here.
    const res = await P.createAgentKey(added, 'Default key')
    reloadKeys()
    if (!res) {
      window.showToast?.(`${name} added, but its key could not be created — mint one below`)
      setOpenKeys(added)
      return
    }
    setFreshAgent({ name, secret: res.secret })
    setCopied(false)
  }
  return (
    <div data-settings-user-detail={mobileUser?.id}>
      {mobileUser && <BackLink to="Users" onClick={() => onBackPage('org-users')} />}
      <PageTitle>{mobileUser ? mobileUser.name : 'Users'}</PageTitle>

      {freshAgent && (
        <div
          data-fresh-agent
          className="[max-width:640px] [border:1px_solid_var(--primary)] [border-radius:var(--r-md)] [padding:20px] [background:var(--accent-soft)]"
        >
          <div className="[font-size:var(--fs-base)] [font-weight:600] [margin-bottom:8px]">
            “{freshAgent.name}” created
          </div>
          <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [margin-bottom:8px]">
            Copy the agent's sign-in key now. It cannot be shown again.
          </div>
          <div className="[display:flex] [gap:8px] [align-items:center]">
            <code
              data-fresh-key
              className="[flex:1] !font-mono [font-size:var(--fs-sm)] [padding:7px_9px] [background:var(--surface-1)] [border:1px_solid_var(--border)] [border-radius:var(--r-sm)] [overflow-x:auto] [white-space:nowrap]"
            >
              {freshAgent.secret}
            </code>
            <Button
              type="button"
              onClick={() =>
                navigator.clipboard.writeText(freshAgent.secret).then(
                  () => setCopied(true),
                  () => {},
                )
              }
            >
              <Icon name={copied ? 'check' : 'copy'} size={16} />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setFreshAgent(null)}>
              Done
            </Button>
          </div>
          <FieldHint>Give this agent project access to let it start working.</FieldHint>
        </div>
      )}

      <SettingsSection title={narrow ? undefined : 'Users'}>
        <div className="[display:flex] [flex-direction:column] [gap:6px]">
          {(mobileUser ? [mobileUser] : roster).map((u) => {
            if (narrow && !mobileUser) {
              return (
                <Button
                  key={u.id}
                  variant="unstyled"
                  className="settings-mobile-menu-row"
                  data-user-row={u.id}
                  data-settings-open-user={u.id}
                  aria-label={`Manage ${u.name}`}
                  onClick={() => setPage(`user:${u.id}`)}
                >
                  <Avatar id={u.id} size={28} />
                  <span className="settings-mobile-menu-copy">
                    <span>
                      {u.name}
                      {u.id === P.CURRENT_USER ? ' (you)' : ''}
                    </span>
                    <span>
                      {u.isAgent ? 'Agent' : u.email || 'No email'} ·{' '}
                      {u.active ? u.orgRole : 'Inactive'}
                    </span>
                  </span>
                  <Icon name="chevronRight" size={16} />
                </Button>
              )
            }
            const lastAdmin = u.orgRole === 'admin' && u.active && admins.length <= 1
            const isSelf = u.id === P.CURRENT_USER
            const blocked = isSelf || lastAdmin
            const arm = confirm === `u:${u.id}`
            const activeKeys = (keys || []).filter((k) => k.agentId === u.id && !k.revokedAt)
            const shownKey = activeKeys[0]
            return (
              <React.Fragment key={u.id}>
                <div
                  data-user-row={u.id}
                  style={{ opacity: u.active ? 1 : 0.62 }}
                  className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
                >
                  <AvatarPicker user={u} />
                  <div className="[flex:1] [min-width:0]">
                    <UserName user={u} isSelf={isSelf} />
                    {/* an agent has no address to show or edit — what stands in its
                    place is the thing it actually signs in with */}
                    {u.isAgent ? (
                      <div
                        data-agent-keyline={u.id}
                        className="[padding-left:6px] [font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
                      >
                        {shownKey ? (
                          <>
                            {agentKeyFingerprint(shownKey.prefix)}
                            {activeKeys.length > 1 ? `, +${activeKeys.length - 1} more` : ''}
                          </>
                        ) : (
                          'no key — cannot sign in'
                        )}
                      </div>
                    ) : (
                      <UserEmail user={u} />
                    )}
                  </div>
                  {/* Org admins may edit each person's planning capacity. */}
                  <PlannableHoursInput user={u} canEdit />
                  {u.isAgent && !DEMO_MODE && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      style={{ background: openKeys === u.id ? 'var(--accent-soft)' : undefined }}
                      className="w-control-sm h-control-sm [flex-shrink:0]"
                      aria-label={
                        openKeys === u.id ? "Hide this agent's keys" : "Manage this agent's keys"
                      }
                      title={
                        openKeys === u.id ? "Hide this agent's keys" : "Manage this agent's keys"
                      }
                      onClick={() => setOpenKeys(openKeys === u.id ? null : u.id)}
                    >
                      <Icon name="zap" size={16} />
                    </Button>
                  )}
                  <UserRoleSelect user={u} isSelf={isSelf} lastAdmin={lastAdmin} />
                  <Button
                    type="button"
                    variant="ghost"
                    size={arm ? 'sm' : 'icon-sm'}
                    disabled={blocked}
                    style={{
                      opacity: blocked ? 0.35 : 1,
                      color: arm ? 'var(--danger)' : undefined,
                    }}
                    className="[flex-shrink:0]"
                    aria-label={
                      isSelf
                        ? "You can't remove yourself"
                        : lastAdmin
                          ? 'Add another admin first'
                          : arm
                            ? 'Click again to confirm removal'
                            : 'Remove from the organization — switch them to Inactive instead to keep their history intact'
                    }
                    title={
                      isSelf
                        ? "You can't remove yourself"
                        : lastAdmin
                          ? 'Add another admin first'
                          : arm
                            ? 'Click again to confirm removal'
                            : 'Remove from the organization — switch them to Inactive instead to keep their history intact'
                    }
                    onClick={() => {
                      if (blocked) return
                      if (!arm) {
                        setConfirm(`u:${u.id}`)
                        return
                      }
                      P.removeUser(u.id)
                      setConfirm(null)
                      window.showToast?.(`${u.name} removed from the organization`)
                    }}
                  >
                    <Icon name="trash" size={16} />
                    {arm && 'Delete?'}
                  </Button>
                </div>
                {u.isAgent && !DEMO_MODE && openKeys === u.id && (
                  <AgentKeyPanel agent={u} keys={keys} reload={reloadKeys} />
                )}
              </React.Fragment>
            )
          })}
        </div>

        {!mobileUser && DEMO_MODE && (
          <DemoCapabilityNotice>
            The demo includes fictional teammates. Adding people or connecting agents is
            unavailable.
          </DemoCapabilityNotice>
        )}
        {!mobileUser && !DEMO_MODE && (
          <SettingsGroup legend="Add a person or an agent">
            {/* Person or agent is the FIRST choice, because it decides what the rest
          of the form even means: a person is an address to sign in with, an
          agent is a key to hand to a machine. */}
            <div className="[display:flex] [gap:8px] [align-items:center] [margin-bottom:8px]">
              {['person', 'agent'].map((k) => (
                <Button
                  type="button"
                  key={k}
                  variant={addKind === k ? 'default' : 'ghost'}
                  data-add-kind={k}
                  // Clear person-only state when switching to an agent: admin
                  // is forbidden and the hidden email must not affect validation.
                  onClick={() => {
                    setAddKind(k === 'agent' ? 'agent' : 'person')
                    setAddEmail('')
                    if (k === 'agent' && addRole === 'admin') setAddRole('user')
                  }}
                  className="h-control-sm [font-size:var(--fs-sm)]"
                >
                  <Icon name={k === 'agent' ? 'zap' : 'user'} size={16} />
                  {k === 'agent' ? 'Agent' : 'Person'}
                </Button>
              ))}
            </div>
            <div className="settings-add-user-form [display:flex] [gap:8px] [align-items:center]">
              <Input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={agentMode ? 'Agent name, e.g. Release Bot' : 'Full name'}
                aria-label={agentMode ? 'New agent name' : 'New person name'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addUser()
                }}
                className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1.2]"
              />
              {!agentMode && (
                <Input
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  placeholder="Email address"
                  data-add-email
                  aria-label="New person email address"
                  type="email"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  title={
                    emailBad
                      ? 'That does not look like an email address'
                      : 'The email address they will use to sign in'
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addUser()
                  }}
                  aria-invalid={emailBad}
                  className="h-control flex-[1.4] bg-surface-1 px-[11px] text-base font-sans"
                />
              )}
              {/* Agents may be read-only but cannot be org admins. */}
              <NativeSelect
                data-add-role
                aria-label="New user role"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as NewUserInput['orgRole'])}
                className="h-control w-[132px] shrink-0 bg-surface-1 px-[11px] font-sans text-sm"
              >
                <option value="user">Standard user</option>
                <option value="viewer">Viewer</option>
                {!agentMode && <option value="admin">Org admin</option>}
              </NativeSelect>
              <Button
                type="button"
                data-add-user
                disabled={!addName.trim() || emailBad || emailMissing}
                title={
                  emailBad
                    ? 'That does not look like an email address'
                    : emailMissing
                      ? 'Email address required'
                      : agentMode
                        ? 'Create the agent and its first key'
                        : undefined
                }
                onClick={addUser}
              >
                <Icon name="plus" size={16} />
                {agentMode ? 'Add agent' : 'Add'}
              </Button>
            </div>
            <FieldHint>
              Active users, including pending invitations, count toward the next monthly renewal.
            </FieldHint>
            {agentMode && <FieldHint>Setting an agent to Inactive stops all its keys.</FieldHint>}
          </SettingsGroup>
        )}
      </SettingsSection>
      {!mobileUser && !DEMO_MODE && guests.length > 0 && (
        <SettingsSection title="Guests" description="Guest hours apply within this organization.">
          <div data-org-guests className="[display:flex] [flex-direction:column] [gap:6px]">
            {guests.map((g) => {
              const on = P.guestProjects(g.id)
              const arm = confirm === `g:${g.id}`
              return (
                <div
                  key={g.id}
                  data-guest-row={g.email || g.id}
                  className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
                >
                  <AvatarPicker user={g} />
                  <div className="[flex:1] [min-width:0]">
                    <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                      {g.email || g.name}
                      {g.pending && (
                        <span className="[color:var(--text-2)] [font-weight:500]">, invited</span>
                      )}
                    </div>
                    <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                      {on.length
                        ? on.map((p) => `${p.name} (${p.level})`).join(', ')
                        : 'no shared projects'}
                    </div>
                  </div>
                  <PlannableHoursInput user={g} canEdit />
                  {/* revoking the seat removes every grant with it; the two
                      clicks match every other destructive control */}
                  <Button
                    type="button"
                    variant="ghost"
                    size={arm ? 'sm' : 'icon-sm'}
                    style={{ color: arm ? 'var(--danger)' : undefined }}
                    className="[flex-shrink:0]"
                    aria-label={
                      arm
                        ? 'Click again to remove this guest'
                        : 'Remove guest — they lose every project shared with them'
                    }
                    title={
                      arm
                        ? 'Click again to remove this guest'
                        : 'Remove guest — they lose every project shared with them'
                    }
                    onClick={() => {
                      if (!arm) {
                        setConfirm(`g:${g.id}`)
                        return
                      }
                      P.removeUser(g.id)
                      setConfirm(null)
                      window.showToast?.(`${g.email || g.name} no longer has access`)
                    }}
                  >
                    <Icon name="trash" size={16} />
                    {arm && 'Delete?'}
                  </Button>
                </div>
              )
            })}
          </div>
        </SettingsSection>
      )}
    </div>
  )
}
