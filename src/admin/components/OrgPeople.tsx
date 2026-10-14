/* An organization's People card. It lists everyone with a seat, signed in or
   invited, with role changes, invitation actions and the signed-in rescue
   actions. Guests get access from project settings, so their rows have no
   role control and no invitation actions. A signed-in guest keeps Recovery
   link and Ban. */
import { UserPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { copyText } from '@/lib/clipboard'
import { restoreFocus } from '@/lib/focusVisibility'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { UserActions } from '../actions'
import {
  cancelInvite,
  fmtWhen,
  type InviteRole,
  isBanned,
  type OrgMember,
  resendInvite,
  setMemberRole,
  signupLink,
} from '../api'
import { Badge, ConfirmAction, StableLabel } from '../ui'
import { EditInviteDialog, InvitePeopleDialog } from './InviteDialogs'
import { LockedRole, RoleSelect } from './RoleControls'

/* Why the only active org admin keeps the role and the invitation. Promoting
   someone or inviting a new org admin both lift it. */
const ANOTHER_ADMIN = 'Add another org admin first'

export function OrgPeople({
  orgId,
  orgName,
  members,
  onChanged,
  onLink,
}: {
  orgId: string
  orgName: string
  members: OrgMember[]
  /* Reloads the organization. Resolves once the page shows the change. */
  onChanged: () => Promise<void>
  onLink: (link: string) => void
}) {
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<OrgMember | null>(null)
  const admins = members.filter((m) => m.org_role === 'admin' && m.active)
  /* The only active org admin keeps the role, and their invitation stays
     while anyone else is in the organization (convex/adminOrgs.ts). */
  const soleAdmin = admins.length === 1 ? admins[0].profile_id : null
  /* An earlier refusal no longer applies once the operator starts on
     something else. */
  const openInvite = () => {
    setError('')
    setInviting(true)
  }
  const openEdit = (member: OrgMember) => {
    setError('')
    setEditing(member)
  }

  return (
    <Card data-org-people="" className="min-w-0 gap-0 overflow-hidden py-0 shadow-card">
      <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 pr-2.5 pl-3">
        <h2 className="text-md font-semibold">People</h2>
        <Button type="button" size="sm" onClick={openInvite}>
          <UserPlus />
          Invite people
        </Button>
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-text-2">
                No one in this organization yet.
              </TableCell>
            </TableRow>
          )}
          {members.map((m) => (
            <PersonRow
              key={m.profile_id}
              member={m}
              soleAdmin={m.profile_id === soleAdmin}
              alone={members.length === 1}
              onChanged={onChanged}
              onEdit={() => openEdit(m)}
              onLink={onLink}
              onError={setError}
            />
          ))}
        </TableBody>
      </Table>
      {inviting && (
        <InvitePeopleDialog
          orgId={orgId}
          orgName={orgName}
          adminFirst={admins.length === 0}
          onClose={() => setInviting(false)}
          onInvited={async () => {
            await onChanged()
            setInviting(false)
          }}
        />
      )}
      {editing && (
        <EditInviteDialog
          orgId={orgId}
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await onChanged()
            setEditing(null)
          }}
        />
      )}
    </Card>
  )
}

/* The first control a keyboard can reach in `scope`. */
const firstControl = (scope: Element | null | undefined) =>
  scope?.querySelector<HTMLElement>(
    'select:not(:disabled), button:not(:disabled), [tabindex="0"]',
  ) ?? null

const focusLost = () => document.activeElement === null || document.activeElement === document.body

/* What the person's seat is doing now. */
function PersonStatus({ member: m }: { member: OrgMember }) {
  let text = 'Invited'
  let danger = false
  if (m.kind === 'agent') text = 'Agent'
  else if (!m.active) text = 'Inactive'
  else if (m.has_login)
    text = m.last_sign_in_at ? `Signed in ${fmtWhen(m.last_sign_in_at)}` : 'Signed in'
  else if (m.invite?.sent) text = `Invited, sent ${fmtWhen(m.invite.at)}`
  else if (m.invite) {
    text = 'Invited, email not sent'
    danger = true
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={danger ? 'text-danger' : 'text-text-1'}>{text}</span>
      {isBanned(m.banned_until) && <Badge kind="danger">banned</Badge>}
    </span>
  )
}

function PersonRow({
  member: m,
  soleAdmin,
  alone,
  onChanged,
  onEdit,
  onLink,
  onError,
}: {
  member: OrgMember
  /* The organization's only active org admin. */
  soleAdmin: boolean
  /* Nobody else is in the organization. */
  alone: boolean
  onChanged: () => Promise<void>
  onEdit: () => void
  onLink: (link: string) => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState('')
  const [pendingRole, setPendingRole] = useState<InviteRole | null>(null)
  const [copied, setCopied] = useState(false)
  const rowRef = useRef<HTMLTableRowElement>(null)
  /* A write disables the row's controls, which drops keyboard focus. These
     remember the focused control to return to afterwards, and where to go
     when a cancelled invite takes the row away. */
  const returnFocus = useRef<HTMLElement | null>(null)
  const fallbackFocus = useRef<() => HTMLElement | null>(() => null)
  useUpdateBlocker(busy !== '')
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => {
    const target = returnFocus.current
    if (busy !== '' || !target) return
    returnFocus.current = null
    if (focusLost()) restoreFocus(target)
  }, [busy])
  useEffect(
    () => () => {
      if (returnFocus.current && focusLost()) restoreFocus(fallbackFocus.current())
    },
    [],
  )

  const run = (label: string, work: () => Promise<unknown>) => {
    const row = rowRef.current
    // A pick from a select's open list leaves focus on the option.
    const active = document.activeElement?.closest<HTMLElement>('select') ?? document.activeElement
    returnFocus.current = active instanceof HTMLElement && row?.contains(active) ? active : null
    const neighbor = row?.nextElementSibling ?? row?.previousElementSibling
    const card = row?.closest('[data-org-people]')
    fallbackFocus.current = () => firstControl(neighbor) ?? firstControl(card)
    const release = beginUpdateBlock()
    setBusy(label)
    onError('')
    work()
      .then(() => onChanged())
      .catch((cause: Error) => onError(cause.message))
      .finally(() => {
        setBusy('')
        setPendingRole(null)
        release()
      })
  }

  const copyLink = () => {
    const link = signupLink()
    onError('')
    void copyText(link).then((ok) => {
      if (ok) setCopied(true)
      else onError(`Could not copy. The sign-up link is ${link}.`)
    })
  }

  const pending = m.kind === 'person' && !m.has_login && m.active && m.org_role !== 'guest'
  const cancelBlocked = soleAdmin && !alone
  return (
    <TableRow ref={rowRef} data-person={m.email ?? m.profile_id}>
      <TableCell className="font-semibold">{m.name}</TableCell>
      <TableCell className="text-sm text-text-1">{m.email}</TableCell>
      <TableCell>
        {m.org_role === 'guest' ? (
          <Badge kind="muted">guest</Badge>
        ) : soleAdmin ? (
          <LockedRole title={ANOTHER_ADMIN} className="w-[148px]" />
        ) : (
          <RoleSelect
            aria-label={`Role for ${m.name}`}
            value={pendingRole ?? m.org_role}
            agent={m.kind === 'agent'}
            disabled={busy !== ''}
            className="w-[148px]"
            onChange={(role) => {
              setPendingRole(role)
              run('role', () => setMemberRole(m.profile_id, role))
            }}
          />
        )}
      </TableCell>
      <TableCell>
        <PersonStatus member={m} />
      </TableCell>
      <TableCell className="text-right">
        {m.has_login ? (
          <UserActions
            email={m.email}
            profileId={m.profile_id}
            orgRole={m.org_role}
            hasLogin={m.has_login}
            banned={isBanned(m.banned_until)}
            promote={false}
            onLink={onLink}
            onChanged={() => void onChanged()}
            onError={onError}
          />
        ) : (
          pending && (
            <span className="inline-flex flex-wrap justify-end gap-2">
              {m.invite && !m.invite.sent && (
                <Button
                  type="button"
                  size="sm"
                  className="px-2"
                  disabled={busy !== ''}
                  onClick={copyLink}
                >
                  <StableLabel
                    labels={['Copy sign-up link', 'Copied']}
                    current={copied ? 'Copied' : 'Copy sign-up link'}
                  />
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                className="px-2"
                disabled={busy !== ''}
                onClick={onEdit}
              >
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                className="px-2"
                disabled={busy !== ''}
                onClick={() => run('resend', () => resendInvite(m.profile_id))}
              >
                <StableLabel
                  labels={['Resend invite', 'Sending…']}
                  current={busy === 'resend' ? 'Sending…' : 'Resend invite'}
                />
              </Button>
              <ConfirmAction
                label="Cancel invite"
                confirmLabel="Click again to cancel"
                busyLabel="Cancelling…"
                busy={busy === 'cancel'}
                disabled={busy !== ''}
                blockedReason={cancelBlocked ? ANOTHER_ADMIN : undefined}
                onConfirm={() => run('cancel', () => cancelInvite(m.profile_id))}
              />
            </span>
          )
        )}
      </TableCell>
    </TableRow>
  )
}
