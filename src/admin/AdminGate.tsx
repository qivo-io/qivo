/* Sign-in gate for the platform-operator area. Independent browser session
   using the same Better Auth accounts (password only). The door opens for accounts in
   platform_admins (checked via api.admin.isOperator — every platform*
   wrapper re-checks on the server, so this gate is UX, not security).
   Non-operators get a flat "no access". */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '../../convex/_generated/api'
import { convex } from '../lib/convex'
import { useUpdateBlocker } from '../lib/updateSafety'
import { AdminApp } from './AdminApp'
import { armConvexAuth, authClient, signOut } from './auth'

type Phase = 'loading' | 'signedOut' | 'denied' | 'ready'

export function AdminGate() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useUpdateBlocker(phase === 'loading' || busy || (phase === 'signedOut' && !!(email || password)))

  /* Arm the Convex socket with the fresh session BEFORE the probe, or
     isOperator lands on an anonymous connection (lib/authSession.ts). Any
     throw reads as denied — the gate never surfaces a console error. */
  async function gate() {
    try {
      await armConvexAuth()
      const ok = await convex.query(api.admin.isOperator, {})
      setPhase(ok === true ? 'ready' : 'denied')
    } catch {
      setPhase('denied')
    }
  }

  useEffect(() => {
    /* The same hole the app's gate had, in a second place: getSession REJECTS
       on a network-level failure instead of returning {error}, and with no
       catch the console sat on "Loading…" for good. Ending on the sign-in
       form is the actionable terminal state — the operator can read what
       happened and retry by signing in. */
    void authClient
      .getSession()
      .then(({ data }) => {
        if (!data?.session) {
          setPhase('signedOut')
          return
        }
        void gate()
      })
      .catch((e) => {
        console.error('[admin] could not establish the session', e)
        setError('Sign-in service unavailable. Check your connection and try again.')
        setPhase('signedOut')
      })
  }, [])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await authClient.signIn.email({ email: email.trim(), password })
    if (error) {
      setError(error.message || 'Could not sign in.')
      setBusy(false)
      return
    }
    await gate()
    setBusy(false)
  }

  if (phase === 'ready') return <AdminApp />

  const shell = (inner: React.ReactNode) => (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] px-5 py-6">
      <Card className="animate-in fade-in slide-in-from-bottom-1 w-full max-w-[400px] gap-0 rounded-lg bg-surface-1 p-6 shadow-pop">
        <header className="mb-7 flex items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-danger text-lg font-bold text-white">
            Q
          </div>
          <div>
            <div className="text-lg font-semibold text-text-1">qivo Admin</div>
            <div className="text-sm text-text-2">Platform operations</div>
          </div>
        </header>
        {inner}
      </Card>
    </div>
  )

  if (phase === 'loading') return shell(<div className="text-base text-text-2">Loading…</div>)

  if (phase === 'denied') {
    return shell(
      <section aria-labelledby="admin-denied-title">
        <h1 id="admin-denied-title" className="mb-2 text-xl font-semibold text-text-1">
          No access
        </h1>
        <p className="mb-6 text-base leading-normal text-text-2">
          Your account does not have platform administrator access.
        </p>
        <Button
          type="button"
          onClick={() => {
            void signOut().then(() => location.reload())
          }}
        >
          Use another account
        </Button>
      </section>,
    )
  }

  return shell(
    <section aria-labelledby="admin-sign-in-title">
      <div className="mb-6">
        <h1 id="admin-sign-in-title" className="text-xl font-semibold text-text-1">
          Sign in to Qivo Admin
        </h1>
        <p className="mt-2 text-sm leading-normal text-text-2">
          Use a platform administrator account to manage organizations, billing and background
          images.
        </p>
      </div>
      <form onSubmit={signIn} aria-busy={busy}>
        <div className="mb-6">
          <Label htmlFor="admin-email" className="text-sm font-normal text-text-1">
            Email
          </Label>
          <Input
            id="admin-email"
            className="mt-2 h-control bg-surface-2 text-base text-text-1"
            type="email"
            autoComplete="username"
            value={email}
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="mb-6">
          <Label htmlFor="admin-password" className="text-sm font-normal text-text-1">
            Password
          </Label>
          <Input
            id="admin-password"
            className="mt-2 h-control bg-surface-2 text-base text-text-1"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div role="alert" className="mb-6 text-sm text-danger">
            {error}
          </div>
        )}
        <Button
          variant="primary"
          className="w-full"
          disabled={busy || !email.trim() || !password}
          type="submit"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </section>,
  )
}
