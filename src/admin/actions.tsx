/* Shared operator user actions. Convex enforces permissions; auth actions
   manage login accounts. Recovery links reach the view once via LinkReveal. */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { authAction, promoteOrgAdmin } from './api'

export function UserActions({
  email,
  profileId,
  orgRole,
  hasLogin,
  banned,
  onLink,
  onChanged,
  onError,
}: {
  email: string | null
  profileId: string
  orgRole: 'admin' | 'user' | 'viewer' | 'guest'
  hasLogin: boolean
  banned: boolean
  onLink: (link: string) => void
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState('')
  useUpdateBlocker(!!busy)

  const run = (label: string, fn: () => Promise<void>) => {
    const releaseUpdateBlock = beginUpdateBlock()
    setBusy(label)
    onError('')
    fn()
      .catch((e: Error) => onError(e.message))
      .finally(() => {
        setBusy('')
        releaseUpdateBlock()
      })
  }

  return (
    <span className="inline-flex flex-wrap justify-end gap-2">
      {/* Guests cannot be promoted here. Viewers remain eligible for lockout
          rescue; the server refuses agents. */}
      {(orgRole === 'user' || orgRole === 'viewer') && (
        <Button
          type="button"
          size="sm"
          className="px-2"
          disabled={busy !== ''}
          onClick={() =>
            run('promote', async () => {
              await promoteOrgAdmin(profileId)
              onChanged()
            })
          }
        >
          {busy === 'promote' ? '…' : 'Make org admin'}
        </Button>
      )}
      {email && hasLogin && (
        <Button
          type="button"
          size="sm"
          className="px-2"
          disabled={busy !== ''}
          title="One-time password reset link"
          onClick={() =>
            run('link', async () => {
              const { link } = await authAction({ action: 'recovery_link', email })
              if (link) onLink(link)
            })
          }
        >
          {busy === 'link' ? '…' : 'Recovery link'}
        </Button>
      )}
      {email && hasLogin && (
        <Button
          type="button"
          size="sm"
          variant="default"
          className={banned ? 'px-2' : 'px-2 text-danger'}
          disabled={busy !== ''}
          title={banned ? 'Lift the sign-in ban' : 'Block this account from signing in'}
          onClick={() =>
            run('ban', async () => {
              await authAction({ action: banned ? 'unban' : 'ban', email })
              onChanged()
            })
          }
        >
          {busy === 'ban' ? '…' : banned ? 'Unban' : 'Ban'}
        </Button>
      )}
    </span>
  )
}
