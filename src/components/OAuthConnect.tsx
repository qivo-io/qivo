import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { api } from '../../convex/_generated/api'
import { authClient } from '../lib/auth'
import { connectionScopeLabel, connectionScopes } from '../lib/oauthConnection'
import { useUpdateBlocker } from '../lib/updateSafety'
import { P } from '../store/planner'

type Context = FunctionReturnType<typeof api.oauthConnections.getContext>

export function OAuthConnect({
  oauthQuery,
  onUseAnotherAccount,
}: {
  oauthQuery: string
  onUseAnotherAccount: () => void
}) {
  const [context, setContext] = useState<Context | null>(null)
  const [allowChanges, setAllowChanges] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [returning, setReturning] = useState(false)
  useUpdateBlocker(true)

  useEffect(() => {
    let active = true
    void P.getOAuthConnectionContext(oauthQuery).then(
      (result) => {
        if (active) setContext(result)
      },
      (failure) => {
        if (!active) return
        const data = failure instanceof ConvexError ? failure.data : null
        setError(
          data && typeof data === 'object' && typeof data.message === 'string'
            ? data.message
            : 'Could not check this connection. Return to your app and try again.',
        )
      },
    )
    return () => {
      active = false
    }
  }, [oauthQuery])

  const decide = async (accept: boolean) => {
    if (!context || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await authClient.oauth2.consent({
        accept,
        scope: connectionScopes(context.scopes, allowChanges).join(' '),
        oauth_query: context.oauthQuery,
      })
      if (result.error || !result.data?.url || !result.data.redirect) {
        setError('Could not complete this connection. Return to your app and try again.')
        setBusy(false)
        return
      }
      // Better Auth follows the server-validated callback. Never navigate to
      // a redirect_uri copied from the page query ourselves.
      setReturning(true)
    } catch {
      setError('Check your connection, then try again.')
      setBusy(false)
    }
  }

  if (!context) {
    return (
      <div>
        <h1 className="mb-3 text-lg font-semibold">Connect an app</h1>
        {error ? (
          <>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            <a className="mt-5 inline-block text-sm text-primary underline" href="/app">
              Open Qivo
            </a>
          </>
        ) : (
          <p role="status" className="text-sm text-text-2">
            Checking this connection…
          </p>
        )}
      </div>
    )
  }

  const wantsChanges = context.scopes.includes('qivo:write')
  const scopes = connectionScopes(context.scopes, allowChanges)
  const hasAccess = scopes.includes('qivo:read') || scopes.includes('qivo:write')
  return (
    <div data-oauth-consent>
      <h1 className="mb-3 break-words text-lg font-semibold">
        Connect {context.clientName} to Qivo
      </h1>
      <p className="mb-3 break-all text-xs text-text-2">Returns to {context.redirectOrigin}</p>
      <p className="mb-4 text-sm text-text-2">
        Only connect an app you intended to use. App names are provided by their developers.
      </p>
      <p className="text-sm text-text-2">
        Signed in as <strong className="text-text-1">{context.profileName}</strong>.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 -ml-2"
        disabled={busy}
        onClick={onUseAnotherAccount}
      >
        Use another account
      </Button>
      <div className="my-5 rounded-md border border-border bg-surface-2 p-3">
        <div className="text-xs text-text-2">Organization</div>
        <div data-oauth-organization className="mt-1 break-words text-base font-semibold">
          {context.orgName}
        </div>
        <p className="mt-2 text-sm text-text-2">
          This connection uses your access in this organization.
        </p>
      </div>
      <ul className="mb-5 list-disc space-y-2 pl-5 text-sm text-text-2">
        {context.scopes
          .filter((scope) => scope !== 'qivo:write')
          .map((scope) => (
            <li key={scope}>{connectionScopeLabel(scope)}</li>
          ))}
      </ul>
      {wantsChanges && (
        <div className="mb-5 flex items-start gap-3">
          <Checkbox
            id="oauth-allow-changes"
            checked={allowChanges}
            disabled={busy}
            onCheckedChange={(checked) => setAllowChanges(checked === true)}
          />
          <div>
            <Label htmlFor="oauth-allow-changes">Allow changes</Label>
            <p className="mt-1 text-sm text-text-2">{connectionScopeLabel('qivo:write')}</p>
          </div>
        </div>
      )}
      <p className="mb-5 text-sm text-text-2">
        You can delete this connection in Settings → User account → MCP access.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {returning && (
        <p role="status" className="mb-4 text-sm text-text-2">
          Returning to {context.clientName}…
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void decide(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy || !hasAccess}
          onClick={() => void decide(true)}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </div>
  )
}
