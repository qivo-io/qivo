/* Shell for the operator area: slim left nav, scrollable content pane.
   Views own their data fetching; the shell owns navigation and sign-out. */

import {
  BarChart3,
  Building2,
  CreditCard,
  Images,
  LayoutDashboard,
  LogOut,
  ScrollText,
  UsersRound,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { authClient, signOut } from './auth'
import { Audit } from './views/Audit'
import { Backgrounds } from './views/Backgrounds'
import { BillingPlans } from './views/BillingPlans'
import { Dashboard } from './views/Dashboard'
import { Demos } from './views/Demos'
import { Orgs } from './views/Orgs'
import { Users } from './views/Users'

type View = 'dashboard' | 'orgs' | 'users' | 'billing' | 'demos' | 'backgrounds' | 'audit'

const NAV: { key: View; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'orgs', label: 'Organizations' },
  { key: 'users', label: 'Users' },
  { key: 'billing', label: 'Billing plans' },
  { key: 'demos', label: 'Demos' },
  { key: 'backgrounds', label: 'Background images' },
  { key: 'audit', label: 'Audit log' },
]

const NAV_ICONS = {
  dashboard: LayoutDashboard,
  orgs: Building2,
  users: UsersRound,
  billing: CreditCard,
  demos: BarChart3,
  backgrounds: Images,
  audit: ScrollText,
} as const

export function AdminApp() {
  const [view, setView] = useState<View>('dashboard')
  const [operator, setOperator] = useState('')

  useEffect(() => {
    void authClient.getSession().then(({ data }) => setOperator(data?.user.email ?? ''))
  }, [])

  return (
    <div
      data-admin-shell
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--bg)] text-text-1 lg:flex-row"
    >
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-[var(--chrome)] lg:flex">
        <AdminBrand />
        <AdminNav view={view} setView={setView} />
        <div className="flex-1" />
        <AdminAccount operator={operator} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-[var(--chrome)]/95 px-3 py-3 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <AdminBrand compact />
            <AdminAccount operator={operator} compact />
          </div>
          <AdminNav view={view} setView={setView} mobile />
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
          <div
            className="animate-in fade-in slide-in-from-bottom-1 mx-auto w-full max-w-[1280px]"
            key={view}
          >
            {view === 'dashboard' && <Dashboard />}
            {view === 'orgs' && <Orgs />}
            {view === 'users' && <Users />}
            {view === 'billing' && <BillingPlans />}
            {view === 'demos' && <Demos />}
            {view === 'backgrounds' && <Backgrounds />}
            {view === 'audit' && <Audit />}
          </div>
        </main>
      </div>
    </div>
  )
}

function AdminBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'flex items-center gap-2' : 'border-b border-border px-6 py-6'}>
      <div className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-card">
        Q
      </div>
      <div className="min-w-0">
        <div className="text-base font-semibold tracking-tight">qivo Admin</div>
        {!compact && <div className="mt-1 text-xs text-text-2">Platform operations</div>}
      </div>
    </div>
  )
}

function AdminNav({
  view,
  setView,
  mobile = false,
}: {
  view: View
  setView: (view: View) => void
  mobile?: boolean
}) {
  return (
    <nav
      aria-label="Admin sections"
      className={
        mobile ? 'mt-3 flex min-w-0 gap-1 overflow-x-auto pb-0.5' : 'flex flex-col gap-1 px-3 py-5'
      }
    >
      {NAV.map((n) => {
        const Icon = NAV_ICONS[n.key]
        const active = view === n.key
        return (
          <Button
            type="button"
            key={n.key}
            aria-current={active ? 'page' : undefined}
            data-on={active ? true : undefined}
            onClick={() => setView(n.key)}
            variant="ghost"
            className={
              mobile
                ? 'h-9 shrink-0 gap-2 px-3 text-xs'
                : 'h-10 w-full justify-start gap-3 rounded-md px-3 text-sm'
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {n.label}
          </Button>
        )
      })}
      {!mobile && (
        <div className="mt-4 border-t border-border pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-3 rounded-md border border-border bg-surface-2 px-3 text-sm hover:bg-surface-3"
            onClick={() => {
              void signOut().then(() => location.reload())
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            <span>Sign out</span>
          </Button>
        </div>
      )}
    </nav>
  )
}

function AdminAccount({ operator, compact = false }: { operator: string; compact?: boolean }) {
  return (
    <div className={compact ? 'flex items-center gap-1' : 'border-t border-border px-3 py-4'}>
      <HoverTooltip content={operator}>
        <div
          className={
            compact
              ? 'max-w-24 truncate px-1 text-xs text-text-2'
              : 'truncate px-3 pb-2 text-xs text-text-2'
          }
        >
          {operator}
        </div>
      </HoverTooltip>
      {compact && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Sign out"
          className="shrink-0 gap-2 px-2"
          onClick={() => {
            void signOut().then(() => location.reload())
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span>Sign out</span>
        </Button>
      )}
    </div>
  )
}
