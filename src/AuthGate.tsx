import { Button } from '@/components/ui/button'
/* Sign-in gate. Not part of the design handoff (the prototype had no auth);
   styled with the same tokens. After sign-in the store loads and the ported
   app takes over.

   Better Auth since the Convex migration (phase 3): email/password sign-in
   and sign-up against the Convex-hosted auth component (src/lib/auth.ts owns
   the client + the Convex token bridge). Since phase 6 the provider buttons
   are live — authClient.signIn.social with the crossDomain return leg
   (?ott= exchange in handleOAuthReturn) — and the password form carries a
   self-serve forgot-password flow: request a link, land back here with
   ?reset=1&token=…, choose a new password.

   Sign-up is self-serve: the marketing site's account button and this form's
   mode switch both lead to /app#signup. Signing up grants nothing by itself — a
   login with no profile lands on "Create your organization", and a login that
   was invited to a project first simply finds that project waiting.

   A seatless login whose address is UNCONFIRMED stops one screen earlier, on
   "Confirm your email address": both doors out of the seatless state are shut
   until the address is proven — createOrganization refuses it (identity.ts)
   and claimSeatsForLogin adopts nothing (0085) — so the organization form
   could only ever be filled in and refused. Entra is how people arrive here:
   Microsoft sends no verified-email claim, Google does. */

import { ConvexError } from 'convex/values'
import { Suspense, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '../convex/_generated/api'
import { AppearanceProvider } from './AppearanceProvider'
import { OAuthConnect } from './components/OAuthConnect'
import { Icon } from './components/qivo'
import { authClient, signOut as authSignOut, handleOAuthReturn } from './lib/auth'
import { convex } from './lib/convex'
import { lazyFromModule } from './lib/lazyModule'
import { oauthConnectRequest, oauthNeedsLogin } from './lib/oauthConnection'
import { beginUpdateBlock, isUpdateBlocked, useUpdateBlocker } from './lib/updateSafety'
import { loadWorkspace, preloadWorkspacePage } from './lib/workspacePreload'
import { initStore, P } from './store/planner'

const App = lazyFromModule(loadWorkspace, (module) => module.default)

function handoffDesktopOAuth(url: URL): boolean {
  // The hosted callback runs in the user's system browser. It must not
  // exchange the one-time token there: hand it back to the waiting desktop
  // shell through its registered protocol instead.
  if (window.qivoDesktop || !url.searchParams.has('desktop_auth')) return false
  const state = url.searchParams.get('desktop_auth') || ''
  const ott = url.searchParams.get('ott') || ''
  const error = url.searchParams.get('error') || ''
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(state)) return false
  if (!ott && !error) return false
  if (ott && !/^[a-zA-Z0-9._~-]{8,2048}$/.test(ott)) return false
  if (error && !/^[A-Z0-9_:-]{1,128}$/i.test(error)) return false
  const callback = new URL('qivo://auth')
  callback.searchParams.set('state', state)
  if (ott) callback.searchParams.set('ott', ott)
  if (error) callback.searchParams.set('error', error)
  window.location.replace(callback.href)
  return true
}

type Phase = 'loading' | 'signedOut' | 'unverified' | 'noProfile' | 'loadFailed' | 'ready'

type SessionResult = Awaited<ReturnType<typeof authClient.getSession>>

function AuthShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-dvh px-5 py-6 [display:grid] [place-items:center]">
      <div
        data-floating-surface
        className={`animate-in fade-in slide-in-from-bottom-1 w-full ${wide ? 'max-w-[480px]' : 'max-w-[340px]'} p-5 [border-radius:var(--r-lg)] [background:var(--surface-1)] [border:1px_solid_var(--border)] [box-shadow:var(--qivo-shadow-pop)]`}
      >
        <div className="[display:flex] [align-items:center] [gap:8px] [margin-bottom:24px]">
          <div className="[width:26px] [height:26px] [border-radius:var(--r-sm)] [background:var(--primary)] [display:grid] [place-items:center] [color:#fff] [font-weight:700] [font-size:var(--fs-base)]">
            Q
          </div>
          <div className="[font-size:var(--fs-xl)] [font-weight:600]">qivo</div>
        </div>
        {children}
      </div>
    </div>
  )
}

function LoadingScreen() {
  return (
    <AuthShell>
      <div
        data-workspace-loading
        role="status"
        className="[color:var(--text-2)] [font-size:var(--fs-base)]"
      >
        Loading…
      </div>
    </AuthShell>
  )
}

/** Keep the loading card over the same background while the workspace loads.
 * Appearance assets continue independently once the planner is ready. */
function WorkspaceStartup({ ready }: { ready: boolean }) {
  /* Background preferences and images are deliberately independent of the
     planner snapshot. They continue loading behind the app, so a slow image
     service can never add an arbitrary two-second blank screen to a login. */
  return ready ? (
    <Suspense fallback={<LoadingScreen />}>
      <App />
    </Suspense>
  ) : (
    <LoadingScreen />
  )
}

/* A code is a machine token, so it is held to one: anything outside this
   shape is not echoed at all. Better Auth surfaces a failed OAuth round trip
   as ?error=<code> on the redirect back — own words only, never provider
   prose above a password field. */
const safeCode = (v: string) => (/^[a-z0-9_.-]{1,40}$/i.test(v) ? v : '')

/* What a Better Auth refusal reads as, in Qivo's own words. The two
   everyday codes get real sentences; everything else falls through to the
   server's message (our own backend's voice), then to the generic line. */
function authErrorText(
  error: { code?: string; message?: string } | null | undefined,
  fallback: string,
): string {
  const code = error?.code ? error.code : ''
  if (
    code === 'INVALID_EMAIL_OR_PASSWORD' ||
    code === 'INVALID_PASSWORD' ||
    code === 'USER_NOT_FOUND'
  ) {
    return 'Wrong email or password.'
  }
  if (code === 'EMAIL_NOT_VERIFIED') {
    // sendOnSignIn (convex/auth.ts) mailed a fresh link on this very attempt
    return 'Confirm your email first. We sent you a new link.'
  }
  /* Better Auth refuses to attach a provider to an address that already signs
     in another way unless the provider vouches for the address, and Entra
     never does (its email claim is tenant-mutable, so trusting it would let a
     tenant admin attach to somebody else's account). Say which door works
     instead of echoing the machine token. */
  if (code.toUpperCase() === 'ACCOUNT_NOT_LINKED') {
    return 'Use your password or the sign-in provider you originally used.'
  }
  if (code === 'USER_ALREADY_EXISTS') {
    return 'That address already has an account — sign in instead.'
  }
  // the reset-password token, spent or past its hour — from the landing
  // redirect (?reset=1&error=INVALID_TOKEN) or the resetPassword call itself
  if (code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED') {
    return 'That reset link has expired — request a new one.'
  }
  return error?.message || fallback
}

export function AuthGate() {
  const [connection] = useState(() => oauthConnectRequest(new URL(location.href)))
  const authReturnURL = connection?.returnURL ?? `${location.origin}/app`
  const [phase, setPhase] = useState<Phase>('loading')
  const [appearanceAccount, setAppearanceAccount] = useState<string | null>(null)
  const loadAttempt = useRef(0)
  const reloadAfterCodeFailure = useRef(false)
  const mounted = useRef(true)
  const signingOut = useRef(false)
  /* Which failure reached the loadFailed screen. The two are not the same
     story: a snapshot that failed to load leaves the account untouched and is
     worth saying so, while a session fetch that never completed cannot claim
     anything about the account, and nothing was fetched at all. */
  const [bootFailed, setBootFailed] = useState(false)
  /* Who the session belongs to, read once from getSession. A ref, not state:
     load() consults it in the same tick the mount effect writes it, and a
     setState would still read the old value there. `mailed` records that
     sign-up ALREADY sent the first link (sendOnSignUp), which is what keeps
     the confirm screen from mailing a duplicate seconds later. */
  const account = useRef<{ email: string; verified: boolean; mailed: boolean } | null>(null)
  const autoSent = useRef(false)
  /* The marketing site now offers Sign in and Create account side by side, and
     they land on the same screen — the fragment is the only thing that tells
     them apart, so `/app#signup` opens on the create-account form. Read once,
     at mount: after that the toggle below owns the mode, and a visitor who
     changes their mind must not be put back by an address nobody rewrote.
     The router ignores it for free (a route fragment starts with a slash). */
  const [mode, setMode] = useState<'in' | 'up' | 'forgot' | 'reset'>(() =>
    location.hash === '#signup' ? 'up' : 'in',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  /* the reset-password token, lifted off ?reset=1&token=… at mount. Only the
     mount effect sets it; a successful reset clears it. */
  const [resetToken, setResetToken] = useState('')
  const [showPw, setShowPw] = useState(false) // never persisted — every visit starts hidden
  const [error, setError] = useState('')
  /* The provider's own wording, when there is any. Kept apart from `error`
     because it is rendered apart: quoted, attributed, and in --text-2, never
     in the app's --danger voice. */
  const [errorDetail, setErrorDetail] = useState('')
  /* WHICH control the message belongs under. An OAuth refusal arriving on a
     page load has no keystroke behind it, and rendering it below the password
     fields put it ~150px under the button that caused it, beneath a form the
     visitor never touched. */
  const [errorAt, setErrorAt] = useState<'form' | 'oauth'>('form')
  const [note, setNote] = useState('')
  const [orgName, setOrgName] = useState('')
  const [busy, setBusy] = useState(false)
  // which provider the browser is on its way to, '' for none
  const [oauth, setOauth] = useState<'' | 'azure' | 'google'>('')
  // Reset tokens are scrubbed from the URL and exist only in this page's
  // memory. Keep the landing intact even before a new password is typed.
  useUpdateBlocker(
    phase === 'loading' ||
      busy ||
      !!oauth ||
      (phase === 'signedOut' && !!(email || password || resetToken)) ||
      (phase === 'noProfile' && !!orgName),
  )
  /* The pressed button, so focus can be handed back to it when the call
     fails: disabling it drops focus to <body>, and the message then renders
     somewhere focus is not. */
  const btns: Record<'azure' | 'google', React.RefObject<HTMLButtonElement | null>> = {
    azure: useRef<HTMLButtonElement>(null),
    google: useRef<HTMLButtonElement>(null),
  }

  /* Whoever the session belongs to, taken from whichever call just
     established it — the OAuth landing, a sign-up, or a sign-in. Every entry
     point must record it, because load() decides between the confirm screen
     and the organization form from exactly this. */
  type SessionUser =
    | { email?: string; emailVerified?: boolean; createdAt?: string | Date }
    | null
    | undefined
  function rememberAccount(user: SessionUser) {
    if (!user) return
    const born = user.createdAt ? new Date(user.createdAt as string).getTime() : NaN
    account.current = {
      email: user.email || '',
      verified: user.emailVerified !== false,
      /* Sign-up mails the first link itself (sendOnSignUp), so an account
         minted moments ago already has one in flight and the confirm screen
         must not send a second. Anything older arrived with nothing. */
      mailed: Number.isFinite(born) && Date.now() - born < 2 * 60 * 1000,
    }
  }

  function showError(message: string, at: 'form' | 'oauth', detail = '') {
    setError(message)
    setErrorDetail(detail)
    setErrorAt(at)
  }

  function clearMessages() {
    setError('')
    setErrorDetail('')
    setNote('')
  }

  /* initStore returns null only when this login genuinely holds no seat, and
     THROWS when the load failed. Conflating the two would answer a network
     blip with "create your organization" — an invitation to a duplicate
     tenant for someone who already has one. */
  async function load(createdOrgId?: string, knownSession?: SessionResult) {
    if (!mounted.current || signingOut.current) return
    const attempt = ++loadAttempt.current
    reloadAfterCodeFailure.current = false
    setAppearanceAccount(null)
    setPhase('loading')
    try {
      // Download the shell and addressed page while authentication and data
      // loading run. Consent-only visits do not need the planner UI.
      if (!connection) preloadWorkspacePage(location.pathname, location.hash)
      // Finish both attempts before offering Retry. An import failure must not
      // leave an older store initializer running beside the next attempt.
      const [storeResult, workspaceResult] = await Promise.allSettled([
        initStore((accountId) => {
          if (attempt === loadAttempt.current) setAppearanceAccount(accountId)
        }, knownSession),
        connection ? null : loadWorkspace(),
      ])
      if (attempt !== loadAttempt.current) return
      if (workspaceResult.status === 'rejected') {
        reloadAfterCodeFailure.current = true
        throw new Error('Check your connection, then try again.')
      }
      if (storeResult.status === 'rejected') throw storeResult.reason
      const ok = storeResult.value
      if (attempt !== loadAttempt.current) return
      if (createdOrgId && P.org.id === createdOrgId && !connection) {
        const billing = await convex
          .query(api.billing.status, { org_id: createdOrgId })
          .catch(() => null)
        if (attempt !== loadAttempt.current) return
        if (billing?.enabled && !billing.writable) {
          history.replaceState(
            null,
            '',
            `/app/${encodeURIComponent(P.org.slug)}/settings/org-billing`,
          )
        }
      }
      /* Seatless AND unconfirmed stops at the confirm screen; seatless alone
         is the organization form. Checked in this order and only here, so a
         login that DOES hold a seat is never gated on verification — the
         break-glass rescue (adminAuth) claims a seat without one. */
      const unverified = account.current !== null && !account.current.verified
      setPhase(connection || ok ? 'ready' : unverified ? 'unverified' : 'noProfile')
    } catch (e) {
      if (attempt !== loadAttempt.current) return
      setAppearanceAccount(null)
      const data = e instanceof ConvexError ? e.data : null
      const msg =
        data && typeof data === 'object' && 'message' in data && data.message
          ? String(data.message)
          : e instanceof Error && e.message
            ? e.message
            : String(e)
      showError(msg, 'form')
      setPhase('loadFailed')
    }
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    void (async () => {
      // read the address before anything rewrites it, then scrub: a failed
      // round trip must not be replayable off the address bar, a reset token
      // is a secret that must not sit in it, and a shared link must not carry
      // an error it did not earn
      const url = new URL(window.location.href)
      if (handoffDesktopOAuth(url)) return
      const authError = safeCode(url.searchParams.get('error') || '')
      /* The reset-password landing. requestPasswordReset sends redirectTo =
         /app?reset=1, and Better Auth's GET /reset-password/:token redirect
         appends &token=<t> (valid) or &error=INVALID_TOKEN (spent/expired) to
         it. The reset marker is ours ON PURPOSE: a failed email-VERIFICATION
         link lands with the same ?error=INVALID_TOKEN code, and without the
         marker the two stories are indistinguishable. */
      const resetLanding = url.searchParams.has('reset')
      const resetTok = url.searchParams.get('token') || ''
      if (
        url.searchParams.has('error') ||
        url.searchParams.has('reset') ||
        url.searchParams.has('token')
      ) {
        url.searchParams.delete('error')
        url.searchParams.delete('reset')
        url.searchParams.delete('token')
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
      }
      if (resetLanding) {
        // the visitor came to set a new password — that outranks any resident
        // session; the machine stays on the gate either way
        if (resetTok) {
          setResetToken(resetTok)
          setMode('reset')
        } else {
          showError(
            authErrorText({ code: authError }, 'That reset link has expired — request a new one.'),
            'form',
          )
        }
        setPhase('signedOut')
        return
      }
      // the OAuth landing (?ott=…) — the crossDomain exchange that makes a
      // social sign-in stick; a no-op when the param is absent
      await handleOAuthReturn()
      if (!active) return
      const sessionResult = await authClient.getSession()
      const { data, error: sessionError } = sessionResult
      if (!active) return
      if (authError || sessionError) {
        console.warn('[auth] sign-in round-trip failed', {
          code: authError,
          session: sessionError ? sessionError.message || String(sessionError.status) : '',
        })
        /* A dead CONFIRMATION link lands here too, and with a session still in
           hand: the reset flow was fenced off above by its ?reset=1 marker, so
           a token code arriving at this point can only be the verification
           one. It used to be swallowed for anyone holding a session — the
           visitor was returned to the app with the link silently dead. */
        const deadLink = authError === 'TOKEN_EXPIRED' || authError === 'INVALID_TOKEN'
        if (deadLink) {
          showError('That confirmation link has expired — send yourself a new one.', 'form')
        } else if (!data?.session) {
          showError(
            authError
              ? authErrorText({ code: authError }, `Sign-in failed (${authError}).`)
              : 'Sign-in failed. Try again.',
            'oauth',
          )
        }
      }
      if (!data?.session) {
        setPhase('signedOut')
        return
      }
      if (connection && oauthNeedsLogin(connection.oauthQuery, data.session.createdAt)) {
        setPhase('signedOut')
        return
      }
      rememberAccount(data.user as SessionUser)
      // If Better Auth returned a session alongside an error, let initStore
      // retry its own read rather than passing a result it will reject.
      await load(undefined, sessionError ? undefined : sessionResult)
    })().catch((e) => {
      if (!active) return
      /* The bootstrap was the one path with no handler of its own: load()'s
         try/catch lives INSIDE it and is never reached when the session fetch
         itself rejects. Better Auth REJECTS on a network-level failure rather
         than returning {error} — an unreachable deployment, a wrong
         VITE_CONVEX_SITE_URL, a CORS refusal — and an unhandled rejection
         here left the gate on "Loading…" for good, with nothing to click and
         nothing in the UI to read. That is exactly the shape a misconfigured
         deployment takes, so it has to end somewhere a person can act. */
      console.error('[auth] could not establish the session', e)
      showError('Check your connection, then try again.', 'form')
      setBootFailed(true)
      setPhase('loadFailed')
    })
    return () => {
      active = false
      mounted.current = false
      loadAttempt.current++
    }
  }, [])

  /* A hash-only navigation does not remount the gate. Follow signup links
     even when the visitor already has the sign-in screen open. */
  useEffect(() => {
    const onHash = () => {
      if (location.hash === '#signup') {
        setMode('up')
        clearMessages()
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /* `oauth` disables BOTH provider buttons, and nothing else can clear it —
     the redirect is supposed to be the last thing that happens on this page.
     When it is not, the flag is stranded: a visitor who presses Back or
     Escape mid-flight, or Back from the consent screen (which restores this
     page from bfcache with the heap intact), returns to two dead buttons and
     no way out but a reload. `pageshow` fires on a fresh load AND on a
     bfcache restore, and covers the never-committed navigation too, since the
     page was never hidden. */
  useEffect(() => {
    const onShow = () => setOauth('')
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    if (mode === 'up') {
      // Better Auth requires a display name at sign-up; the address's local
      // part is the same fallback createOrganization uses server-side, so the
      // name a password sign-up starts with matches what the org creator
      // screen would derive anyway. People rename via Settings (0116).
      const addr = email.trim()
      const { data, error } = await authClient.signUp.email({
        email: addr,
        password,
        name: addr.split('@')[0] || addr,
        // the confirmation link's landing; unset, Better Auth encodes "/" and
        // the confirmed visitor is dropped on the marketing home instead
        callbackURL: authReturnURL,
      })
      setShowPw(false)
      if (error) {
        showError(authErrorText(error, 'Sign-up failed. Try again.'), 'form')
        setBusy(false)
        return
      }
      // email verification is on, so there is no session yet — say so instead
      // of dropping the user on a blank screen
      if (!data?.token) {
        setNote('Check your inbox to confirm the address, then sign in.')
        setMode('in')
        setBusy(false)
        return
      }
      rememberAccount((data as { user?: SessionUser }).user)
    } else {
      /* No callbackURL here, deliberately: Better Auth answers a sign-in that
         carries one with redirect:true, and the client then NAVIGATES — every
         password sign-in would become a full page load instead of the in-page
         hand-off to the app. The resend it would have addressed goes out with
         better-auth's own default landing; the confirm screen's own resend
         (sendVerification) is the one that carries /app. */
      const { data, error } = await authClient.signIn.email({ email: email.trim(), password })
      setShowPw(false)
      if (error) {
        showError(authErrorText(error, 'Sign-in failed. Try again.'), 'form')
        setBusy(false)
        return
      }
      // The OAuth provider resumes authorization after password login. Its
      // client follows that validated redirect; do not mount the planner meanwhile.
      if (connection && data?.redirect && data.url) return
      rememberAccount((data as { user?: SessionUser } | null)?.user)
    }
    await load()
    setBusy(false)
  }

  /* Social sign-in. On success the client follows the provider redirect and
     this page unloads; the return leg is the mount effect's handleOAuthReturn
     (?ott=) or the ?error= scrub. Only a refusal comes back here — surface it
     under the buttons in our own words, quote the server in the attributed
     slot, and hand focus back to the button that lost it (flushSync so the
     re-enable has reached the DOM before .focus() — a disabled button
     swallows it). */
  async function social(provider: 'azure' | 'google') {
    setOauth(provider)
    clearMessages()
    try {
      const desktop = window.qivoDesktop
      const callbackURL = desktop ? (await desktop.auth.beginOAuth()).callbackURL : authReturnURL
      const { data, error } = await authClient.signIn.social({
        provider: provider === 'azure' ? 'microsoft' : 'google',
        callbackURL,
        /* A refused round trip redirects to errorCallbackURL, and unset it is
         * Better Auth's OWN error page on the convex.site origin — a raw code
         * on a page with no route back to Qivo. Bring it home, where the mount
         * effect turns the code into a sentence under these buttons. */
        errorCallbackURL: callbackURL,
        // Electron hands the provider URL to the system browser. The hosted
        // callback then returns its one-time token through qivo://.
        disableRedirect: Boolean(desktop),
      })
      if (!error && desktop && data?.url) {
        const opened = await desktop.auth.openOAuth(data.url)
        if (!opened) throw new Error('The sign-in provider could not be opened.')
      }
      if (error) throw error
    } catch (error) {
      const detail =
        error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
      flushSync(() => {
        setOauth('')
        showError('Sign-in failed. Try again.', 'oauth', detail)
      })
      btns[provider].current?.focus()
    }
  }

  /* Forgot password, step 1: mail the link. The success copy is uniform on
     purpose — the server answers status:true whether or not the address has
     an account (anti-enumeration), and the client must not reintroduce the
     oracle it withholds. */
  async function requestReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    const returnURL = new URL(authReturnURL)
    returnURL.searchParams.set('reset', '1')
    const { error } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: returnURL.href,
    })
    setBusy(false)
    if (error) {
      showError(authErrorText(error, "Couldn't send the reset link. Try again."), 'form')
      return
    }
    setNote('If that address has an account, you’ll receive a reset link.')
    setMode('in')
  }

  // Forgot password, step 2: the landing form spends the token. Back to
  // sign-in on success — the reset never signs anyone in by itself.
  async function applyReset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    const { error } = await authClient.resetPassword({ newPassword: password, token: resetToken })
    setShowPw(false)
    setBusy(false)
    if (error) {
      showError(authErrorText(error, "Couldn't set the new password. Try again."), 'form')
      return
    }
    setPassword('')
    setResetToken('')
    setNote('Password updated — sign in with the new one.')
    setMode('in')
  }

  /* Better Auth mails a confirmation link on the REGISTRATION and never
     again, so every returning unconfirmed login would otherwise sit in front
     of a link that has expired (an hour) with no way to ask for another. This
     is that way: on arrival when nothing is in flight, and on the button. */
  async function sendVerification(manual: boolean) {
    const addr = account.current?.email || ''
    if (!addr) return
    if (manual) {
      setBusy(true)
      clearMessages()
    }
    const releaseUpdateBlock = beginUpdateBlock()
    const { error } = await authClient
      .sendVerificationEmail({
        email: addr,
        // without it the link's own callbackURL defaults to the marketing root
        callbackURL: authReturnURL,
      })
      .finally(releaseUpdateBlock)
    if (manual) setBusy(false)
    if (error) {
      showError(authErrorText(error, "Couldn't send the confirmation email. Try again."), 'form')
      return
    }
    setNote('Confirmation email sent — check your inbox.')
  }

  useEffect(() => {
    if (phase !== 'unverified' || autoSent.current) return
    autoSent.current = true
    // the registration's own link is still fresh — say so, don't duplicate it
    if (account.current?.mailed) {
      setNote('Confirmation email sent — check your inbox.')
      return
    }
    void sendVerification(false)
  }, [phase])

  async function createOrg(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    clearMessages()
    let createdOrgId: string
    try {
      createdOrgId = await convex.mutation(api.identity.createOrganization, {
        name: orgName.trim(),
      })
    } catch (err) {
      const data = err instanceof ConvexError ? err.data : null
      const msg =
        data && typeof data === 'object' && 'message' in data && data.message
          ? String(data.message)
          : "couldn't create the organization"
      showError(msg.charAt(0).toUpperCase() + msg.slice(1), 'form')
      setBusy(false)
      return
    }
    await load(createdOrgId)
    setBusy(false)
  }

  const signOutAndReload = () => {
    signingOut.current = true
    loadAttempt.current++
    setAppearanceAccount(null)
    setPhase('loading')
    void authSignOut().then(
      () => location.reload(),
      () => location.reload(),
    )
  }

  // The connection URL carries the signed authorization request. Keep this
  // route outside App, whose normal URL synchronization owns planner paths.
  if (connection && phase === 'ready')
    return (
      <AuthShell wide>
        <OAuthConnect oauthQuery={connection.oauthQuery} onUseAnotherAccount={signOutAndReload} />
      </AuthShell>
    )

  if (appearanceAccount && (phase === 'loading' || phase === 'ready'))
    return (
      <AppearanceProvider key={appearanceAccount} accountId={appearanceAccount}>
        <WorkspaceStartup ready={phase === 'ready'} />
      </AppearanceProvider>
    )

  const shell = (inner: React.ReactNode) => <AuthShell>{inner}</AuthShell>

  if (phase === 'loading' || phase === 'ready') return <LoadingScreen />

  // the snapshot failed to load — say THAT, and offer a retry. Never the
  // create-an-organization form: this login may well already have one.
  if (phase === 'loadFailed') {
    return shell(
      <div>
        <div className="[font-size:var(--fs-md)] [font-weight:600] [margin-bottom:8px]">
          {bootFailed ? "Couldn't reach Qivo" : "Couldn't load your workspace"}
        </div>
        {error && (
          <div className="[color:var(--danger)] [font-size:var(--fs-sm)] [margin-bottom:24px]">
            {error}
          </div>
        )}
        <Button
          type="button"
          variant="primary"
          className="[width:100%] [justify-content:center]"
          onClick={() => {
            // Browsers can retain a failed module import for this document.
            // A fresh document can request the repaired workspace code again.
            if (reloadAfterCodeFailure.current) {
              if (!isUpdateBlocked()) location.reload()
              return
            }
            clearMessages()
            setBootFailed(false)
            setPhase('loading')
            /* load() re-enters initStore, which fetches the session itself, so
               it is a real retry of the boot as well as of the snapshot. */
            void load()
          }}
        >
          Try again
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="[width:100%] [justify-content:center] [margin-top:8px]"
          onClick={signOutAndReload}
        >
          Sign out
        </Button>
      </div>,
    )
  }

  /* Everything the provider buttons look like lives in `.tbtn.provider`
     (tokens.css), because a variant needs :hover and :disabled and an inline
     style object can express neither — and would outrank both. Only the
     per-call-site layout stays here, which is what the rest of this file does
     too. */
  /* The separator between sign-in methods has lighter styling than field
     labels so "or" does not read as a heading for the email field. */
  /* A navigation between screens of the gate, not an action of button weight —
     the same demotion the mode toggle got when the button ladder grew. */
  const fieldClass = 'mt-2 h-control bg-surface-2 px-2.5 text-base'
  const labelClass = 'text-sm font-normal text-text-1'
  const textLinkClass =
    'h-auto p-0 text-sm font-medium text-text-1 underline underline-offset-4 hover:bg-transparent hover:text-text-1'

  /* One error line, rendered under whichever control produced it. `role`
     announces it, which matters most on the one path with no keystroke behind
     it — an auth error that arrives as a page load. */
  const errorLine = () => (
    <div role="alert" className="[margin-bottom:24px]">
      <div className="[color:var(--danger)] [font-size:var(--fs-sm)]">{error}</div>
      {errorDetail && (
        <div className="[color:var(--text-2)] [font-size:var(--fs-xs)] [margin-top:4px] [line-height:1.45]">
          Reported by the provider: “{errorDetail}”
        </div>
      )}
    </div>
  )

  /* Signed in, seatless, and unconfirmed. The organization form below is
     what this used to be, and it could only ever be filled in and refused —
     so it is replaced until the address is proven, rather than dressed with a
     warning. Reload rather than a re-check: the link is usually opened on a
     phone, and this tab's session must be refetched, not re-read. */
  if (phase === 'unverified') {
    return shell(
      <div>
        <div className="[font-size:var(--fs-md)] [font-weight:600] [margin-bottom:8px]">
          Confirm your email address
        </div>
        <div className="[display:flex] [align-items:center] [gap:8px] [margin-bottom:8px] [font-size:var(--fs-base)] [color:var(--text-1)]">
          <Icon name="mail" size={16} />
          <span data-confirm-address className="[overflow-wrap:anywhere]">
            {account.current?.email}
          </span>
        </div>
        <div className="[color:var(--text-2)] [font-size:var(--fs-base)] [line-height:1.5] [margin-bottom:24px]">
          The link expires in one hour.
        </div>
        {error && errorLine()}
        {note && (
          <div className="[color:var(--text-2)] [font-size:var(--fs-sm)] [margin-bottom:24px]">
            {note}
          </div>
        )}
        <Button
          type="button"
          variant="primary"
          data-auth-resend
          className="[width:100%] [justify-content:center]"
          disabled={busy}
          onClick={() => void sendVerification(true)}
        >
          {busy ? 'Sending…' : 'Resend confirmation email'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="[width:100%] [justify-content:center] [margin-top:8px]"
          onClick={signOutAndReload}
        >
          Use another account
        </Button>
        <div className="[margin-top:24px] [text-align:center]">
          <Button
            type="button"
            data-auth-recheck
            className={textLinkClass}
            onClick={() => location.reload()}
            variant="unstyled"
          >
            Already confirmed? Reload
          </Button>
        </div>
      </div>,
    )
  }

  // a login with no profile anywhere: it belongs to nobody yet, so the only
  // thing to do is start an organization (an invitation would have given it a
  // guest seat, and claimMySeats picks those up at boot)
  if (phase === 'noProfile') {
    return shell(
      <form onSubmit={createOrg}>
        <div className="[font-size:var(--fs-md)] [font-weight:600] [margin-bottom:8px]">
          Create your organization
        </div>
        <div className="[color:var(--text-2)] [font-size:var(--fs-base)] [line-height:1.5] [margin-bottom:24px]">
          If you expected an invitation, check which email address it was sent to.
        </div>
        <div className="[margin-bottom:24px]">
          <Label htmlFor="organization-name" className={labelClass}>
            Organization name
          </Label>
          <Input
            id="organization-name"
            className={fieldClass}
            value={orgName}
            autoFocus
            data-create-org
            onChange={(e) => setOrgName(e.target.value)}
          />
        </div>
        {error && (
          <div className="[color:var(--danger)] [font-size:var(--fs-sm)] [margin-bottom:24px]">
            {error}
          </div>
        )}
        <Button
          variant="primary"
          className="[width:100%] [justify-content:center]"
          disabled={busy || !orgName.trim()}
          type="submit"
        >
          {busy ? 'Creating…' : 'Create organization'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="[width:100%] [justify-content:center] [margin-top:8px]"
          onClick={signOutAndReload}
        >
          Use another account
        </Button>
      </form>,
    )
  }

  // forgot password, step 1: ask for the link. Its submit button exists only
  // in this mode, so the drive scripts' first-button[type=submit] contract on
  // the default card is untouched.
  if (mode === 'forgot') {
    return shell(
      <form onSubmit={requestReset}>
        <div className="[font-size:var(--fs-md)] [font-weight:600] [margin-bottom:8px]">
          Reset your password
        </div>
        <div className="[margin-bottom:24px]">
          <Label htmlFor="reset-email" className={labelClass}>
            Email
          </Label>
          <Input
            id="reset-email"
            className={fieldClass}
            type="email"
            value={email}
            autoFocus
            data-auth-reset-email
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {error && errorLine()}
        <Button
          variant="primary"
          className="[width:100%] [justify-content:center]"
          disabled={busy || !email.trim()}
          type="submit"
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <div className="[margin-top:24px] [text-align:center]">
          <Button
            type="button"
            className={textLinkClass}
            onClick={() => {
              setMode('in')
              clearMessages()
            }}
            variant="unstyled"
          >
            Back to sign in
          </Button>
        </div>
      </form>,
    )
  }

  // forgot password, step 2: the reset landing (?reset=1&token=…) spends the
  // token on a new password, then hands over to the sign-in form
  if (mode === 'reset') {
    return shell(
      <form onSubmit={applyReset}>
        <div className="[font-size:var(--fs-md)] [font-weight:600] [margin-bottom:8px]">
          Choose a new password
        </div>
        <div className="[margin-bottom:24px]">
          <Label htmlFor="new-password" className={labelClass}>
            New password
          </Label>
          <div className="[position:relative]">
            <Input
              id="new-password"
              className={`${fieldClass} pr-10`}
              type={showPw ? 'text' : 'password'}
              value={password}
              autoFocus
              data-auth-reset-password
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              title={showPw ? 'Hide password' : 'Show password'}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="[position:absolute] right-px top-2 size-8 [display:grid] [place-items:center] [background:none] [border:none] [cursor:pointer] [color:var(--text-1)] [padding:0]"
              variant="unstyled"
            >
              <Icon name={showPw ? 'eyeOff' : 'eye'} size={16} />
            </Button>
          </div>
        </div>
        {error && errorLine()}
        <Button
          variant="primary"
          className="[width:100%] [justify-content:center]"
          disabled={busy || !password}
          type="submit"
        >
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
        <div className="[margin-top:24px] [text-align:center]">
          <Button
            type="button"
            className={textLinkClass}
            onClick={() => {
              setMode('in')
              setResetToken('')
              setPassword('')
              clearMessages()
            }}
            variant="unstyled"
          >
            Back to sign in
          </Button>
        </div>
      </form>,
    )
  }

  /* The card commits to ONE story: the providers lead. Adding them made it
     tell three at once — position said providers, colour said the accent
     `Sign in`, and `autoFocus` put the caret past both, so the first control
     on the screen was reachable only by Shift+Tab. So all three signals agree
     now: the providers come first, they are the tall control (--ctl-lg against
     the form's --ctl-md), and `autoFocus` comes OFF the email input while they
     are rendered. The accent-filled `Sign in` stays the form's own submit, and
     the mode toggle leaves the button ladder for a text line — it switches
     between two screens, it is not a fourth action of equal weight, and four
     full-width buttons of which two differ only by a border is what the ladder
     had become. */
  const verb = mode === 'up' ? 'Sign up with' : 'Sign in with'
  const providerButton = (
    provider: 'azure' | 'google',
    name: string,
    mark: React.ReactNode,
    extraClass?: string,
  ) => (
    <Button
      type="button"
      ref={btns[provider]}
      variant="provider"
      size="lg"
      /* The hook says `azure` while the label says Microsoft, on purpose:
         `azure` was the legacy provider id and is the fact the existing
         drives key on; the Better Auth provider id (`microsoft`) lives only
         in social()'s mapping. Kept at the phase-6 rewire — renaming the hook
         buys nothing and breaks every drive that keys on it. */
      {...{ [`data-oauth-${provider}`]: true }}
      className={`w-full justify-center ${extraClass ?? ''}`}
      disabled={oauth !== ''}
      aria-busy={oauth === provider}
      onClick={() => void social(provider)}
    >
      {mark}
      {`${verb} ${name}`}
    </Button>
  )

  return shell(
    <form onSubmit={submit}>
      {/* Microsoft first: Entra is the identity most of the people this is
          sold to already sign in with every morning.
          `type="button"` on both, and it is not decoration — a <button> with
          no type submits, and thirty-six drive scripts sign in on this screen
          by clicking `button[type=submit]`, taking the FIRST match on the page
          (37 files match repo-wide; the extra one is the operator console's
          own AdminGate, a different screen). An untyped button here would
          swallow every one of them.
          The email and password form below stays mounted and unhidden on
          the default render — never behind a disclosure. See the drive
          count above. */}
      {error && errorAt === 'oauth' && errorLine()}
      {providerButton('azure', 'Microsoft', <MicrosoftMark />)}
      {providerButton('google', 'Google', <GoogleMark />, 'mt-2')}
      <div className="[display:flex] [align-items:center] [gap:8px] [margin:24px_0]">
        <span className="[flex:1] [height:1px] [background:var(--border)]" />
        <span className="text-xs text-text-2">or</span>
        <span className="[flex:1] [height:1px] [background:var(--border)]" />
      </div>
      <div className="[margin-bottom:24px]">
        <Label htmlFor="auth-email" className={labelClass}>
          Email
        </Label>
        <Input
          id="auth-email"
          className={fieldClass}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="[margin-bottom:24px]">
        <div className="[display:flex] [justify-content:space-between] [align-items:baseline]">
          <Label htmlFor="auth-password" className={labelClass}>
            Password
          </Label>
          {mode === 'in' && (
            <Button
              type="button"
              data-auth-forgot
              onClick={() => {
                setMode('forgot')
                clearMessages()
              }}
              className={textLinkClass}
              variant="unstyled"
            >
              Forgot password?
            </Button>
          )}
        </div>
        <div className="[position:relative]">
          <Input
            id="auth-password"
            className={`${fieldClass} pr-10`}
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            title={showPw ? 'Hide password' : 'Show password'}
            aria-label={showPw ? 'Hide password' : 'Show password'}
            className="[position:absolute] right-px top-2 size-8 [display:grid] [place-items:center] [background:none] [border:none] [cursor:pointer] [color:var(--text-1)] [padding:0]"
            variant="unstyled"
          >
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={16} />
          </Button>
        </div>
      </div>
      {error && errorAt === 'form' && errorLine()}
      {note && (
        <div className="[color:var(--text-2)] [font-size:var(--fs-sm)] [margin-bottom:24px]">
          {note}
        </div>
      )}
      <Button
        variant="primary"
        className="[width:100%] [justify-content:center]"
        disabled={busy || !email.trim() || !password}
        type="submit"
      >
        {busy
          ? mode === 'up'
            ? 'Creating…'
            : 'Signing in…'
          : mode === 'up'
            ? 'Create account'
            : 'Sign in'}
      </Button>
      <div className="[margin-top:24px] [text-align:center]">
        <Button
          type="button"
          data-auth-toggle
          disabled={busy || !!oauth}
          onClick={() => {
            const nextMode = mode === 'up' ? 'in' : 'up'
            setMode(nextMode)
            const url = new URL(location.href)
            url.hash = nextMode === 'up' ? 'signup' : ''
            history.replaceState(null, '', url)
            clearMessages()
          }}
          className={textLinkClass}
          variant="unstyled"
        >
          {mode === 'up' ? 'I already have an account' : 'Create an account'}
        </Button>
      </div>
    </form>,
  )
}

/* The two provider marks, hand-written here rather than added to ICON_PATHS.
   That registry's contract is one Lucide-style line glyph per name — 24-grid,
   1.75 stroke, currentColor — and these are filled, four-coloured, and on
   grids of their own. They are also trademarks: the hexes are the brands' own
   and are the one place on this screen where a literal colour is correct, the
   same exemption AVATAR_COLORS holds. Do not tokenise
   them, do not recolour them, and do not fetch them from a CDN — a login
   screen should not beacon a third party, and an inlined mark still works when
   the CDN does not.

   ONE size for both, or a later edit moves one mark and not the other. 16
   sits under Google's published 18px minimum and Microsoft's 21px — the same
   deliberate house deviation `.tbtn.provider` records for the button chrome,
   made once and in one place. They stay in this file rather than moving to
   `src/components`: this is the only screen that renders them today, and the
   comment above is the part worth keeping next to them. Phase 2's Settings ›
   Access page (§5.8) is the moment to export them, not before. */
const MARK = 16

function MicrosoftMark() {
  return (
    <svg
      width={MARK}
      height={MARK}
      viewBox="0 0 23 23"
      className="[flex-shrink:0] [display:block]"
      aria-hidden="true"
    >
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#7fba00" d="M12 1h10v10H12z" />
      <path fill="#00a4ef" d="M1 12h10v10H1z" />
      <path fill="#ffb900" d="M12 12h10v10H12z" />
    </svg>
  )
}

function GoogleMark() {
  return (
    <svg
      width={MARK}
      height={MARK}
      viewBox="0 0 48 48"
      className="[flex-shrink:0] [display:block]"
      aria-hidden="true"
    >
      <path
        fill="#ea4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285f4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#fbbc05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34a853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}
