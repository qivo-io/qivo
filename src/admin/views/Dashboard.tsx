/* Platform totals and activity, followed by the shared demo creation report. */
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { DemoMetricsResult } from '../../../convex/lib/demoMetricsReport'
import { demoMetrics, fmtBytes, type PlatformStats, platformStats } from '../api'
import { AdminEmptyState, AdminPageHeader, AdminStat, ErrorNote, Loading } from '../ui'
import { DemoCreationChart, MetricsChart } from './Demos'

export function Dashboard() {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [error, setError] = useState('')
  const [demoResult, setDemoResult] = useState<DemoMetricsResult | null>(null)
  const [demoError, setDemoError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [demoLoading, setDemoLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setDemoLoading(true)
    setError('')
    setDemoError('')
    platformStats()
      .then((data) => {
        if (!active) return
        setStats(data)
        setUpdatedAt(Date.now())
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : 'Could not load platform activity.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    demoMetrics()
      .then((data) => {
        if (active) setDemoResult(data)
      })
      .catch((error: unknown) => {
        if (active)
          setDemoError(error instanceof Error ? error.message : 'Could not load demo usage.')
      })
      .finally(() => {
        if (active) setDemoLoading(false)
      })
    return () => {
      active = false
    }
  }, [attempt])

  const refresh = () => setAttempt((value) => value + 1)
  const busy = loading || demoLoading
  const t = stats?.totals
  const tiles = t
    ? [
        { label: 'Organizations', value: t.orgs.toLocaleString(), note: 'Across the platform' },
        {
          label: 'Members',
          value: t.members.toLocaleString(),
          note: `${t.logins.toLocaleString()} with a login`,
        },
        { label: 'Teams', value: t.teams.toLocaleString(), note: 'Across all organizations' },
        { label: 'Projects', value: t.projects.toLocaleString(), note: 'Across all organizations' },
        { label: 'Tasks', value: t.issues.toLocaleString(), note: 'Across all projects' },
        {
          label: 'Activity, 30d',
          value: t.activity_30d.toLocaleString(),
          note: 'Recorded activity events',
        },
        {
          label: 'Database size',
          value: fmtBytes(t.db_total_bytes),
          note: 'Approximate application data',
        },
      ]
    : []

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Dashboard"
        description="Platform activity, workspace totals and demo growth."
        actions={
          <Button type="button" disabled={busy} onClick={refresh}>
            <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <section className="space-y-4" aria-label="Platform overview" aria-busy={loading}>
        {error && (
          <div role="alert">
            <ErrorNote message={error} />
          </div>
        )}
        {!stats && loading && <Loading />}
        {!stats && error && (
          <AdminEmptyState
            title="Platform overview is unavailable"
            description="Try refreshing to load the latest totals and activity."
            action={
              <Button type="button" onClick={refresh} disabled={busy}>
                Try again
              </Button>
            }
          />
        )}
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {tiles.map((tile) => (
                <AdminStat key={tile.label} {...tile} />
              ))}
            </div>
            {updatedAt !== null && (
              <p className="text-xs text-text-2">
                Platform totals updated{' '}
                {new Date(updatedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .{loading ? ' Refreshing…' : ' Refresh to check for new activity.'}
              </p>
            )}
            <Card className="gap-5 p-5 sm:p-6">
              <div>
                <h2 className="text-md font-semibold">Activity events per week</h2>
                <p className="mt-1 text-sm text-text-2">Last 12 weeks across all organizations.</p>
              </div>
              {stats.weekly.length ? (
                <MetricsChart
                  label="Activity events per week"
                  rows={stats.weekly.slice(-12).map((week) => {
                    const date = new Date(week.week).toLocaleDateString(undefined, {
                      timeZone: 'UTC',
                      day: 'numeric',
                      month: 'short',
                    })
                    return {
                      key: week.week,
                      label: `Week of ${date}`,
                      shortLabel: date,
                      value: week.activity,
                      detail: `${week.new_members.toLocaleString()} new members`,
                    }
                  })}
                  format={(value) => value.toLocaleString()}
                  valueColumnLabel="Events"
                />
              ) : (
                <AdminEmptyState
                  title="No activity yet"
                  description="Weekly activity will appear as people use their workspaces."
                />
              )}
            </Card>
          </>
        )}
      </section>
      <section className="space-y-3" aria-label="Demo workspace growth" aria-busy={demoLoading}>
        {demoError && (
          <div role="alert">
            <ErrorNote message={demoError} />
          </div>
        )}
        {!demoResult && demoLoading && (
          <Card className="gap-3 p-5 sm:p-6">
            <h2 className="text-md font-semibold">Demo workspaces created</h2>
            <Loading />
          </Card>
        )}
        {!demoResult && demoError && (
          <AdminEmptyState
            title="Demo reporting could not be loaded"
            description="The platform overview remains available. Refresh to try the demo report again."
            action={
              <Button type="button" onClick={refresh} disabled={busy}>
                Try again
              </Button>
            }
          />
        )}
        {demoResult?.status === 'not_configured' && (
          <AdminEmptyState
            title="Demo reporting is not connected yet"
            description={demoResult.message}
          />
        )}
        {demoResult?.status === 'ready' && (
          <DemoCreationChart report={demoResult.report} showFreshness />
        )}
      </section>
    </div>
  )
}
