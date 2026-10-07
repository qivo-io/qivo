import { RefreshCw } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  DEFAULT_DEMO_COST_SETTINGS,
  DEMO_CONVEX_PRICING_CHECKED_AT,
  DEMO_CONVEX_PRICING_SOURCE,
  DEMO_STORAGE_STALE_MS,
  type DemoChartPeriod,
  type DemoCostSettings,
  type DemoCountPeriod,
  demoCreationSeries,
  demoStorageSeries,
  demoSummary,
  estimateDemoMonthlyCost,
  fmtDemoBytes,
  parseDemoPrice,
  readDemoCostSettings,
} from '@/lib/demoMetrics'
import type { DemoMetricsReport, DemoMetricsResult } from '../../../convex/lib/demoMetricsReport'
import { demoMetrics } from '../api'
import { AdminPageHeader, AdminStat, ErrorNote, Loading } from '../ui'

const COST_KEY = 'qivo:admin:demo-cost-estimate:v1'
const number = (value: number) => value.toLocaleString()
const dateLabel = (date: string, monthOnly = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    ...(monthOnly ? {} : { day: 'numeric' }),
  })
const timestampLabel = (timestamp: number) =>
  `${new Date(timestamp).toLocaleString(undefined, { timeZone: 'UTC' })} UTC`
const periodLabel = (period: DemoCountPeriod) =>
  `${dateLabel(period.start)} – ${dateLabel(period.end)}`
const countLabel = (period: DemoCountPeriod) =>
  period.value === null
    ? 'Unavailable'
    : `${number(period.value)}${period.complete ? '' : ' recorded'}`

export function Demos() {
  const [result, setResult] = useState<DemoMetricsResult | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    demoMetrics()
      .then((data) => {
        if (active) setResult(data)
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : 'Could not load demo usage.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [attempt])
  return (
    <div className="space-y-6" data-demo-metrics>
      <AdminPageHeader
        title="Demos"
        description="24-hour demo workspaces, usage and monthly cost estimate."
        actions={
          <Button type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      {error && (
        <div role="alert">
          <ErrorNote message={error} />
        </div>
      )}
      {!result && loading && (
        <div className="rounded-lg border border-border bg-card p-6">
          <Loading />
        </div>
      )}
      {result?.status === 'not_configured' && (
        <Card className="gap-2 p-5 shadow-card sm:p-6">
          <h2 className="text-md font-semibold">Demo reporting is not connected yet</h2>
          <p className="text-sm text-text-2">{result.message}</p>
        </Card>
      )}
      {result?.status === 'ready' && <DemoReport report={result.report} />}
    </div>
  )
}

function DemoReport({ report }: { report: DemoMetricsReport }) {
  const [period, setPeriod] = useState<DemoChartPeriod>('30d')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const summary = demoSummary(report)
  const year = new Date(report.generatedAt).getUTCFullYear()
  const tiles = [
    {
      label: 'Total recorded',
      value: number(report.totalCreated),
      note: 'Includes expired and deleted demos since recording began.',
    },
    {
      label: 'Last 7 days',
      value: countLabel(summary.last7Days),
      note: periodLabel(summary.last7Days),
      partial: !summary.last7Days.complete,
    },
    {
      label: 'Last 12 months',
      value: countLabel(summary.last12Months),
      note: periodLabel(summary.last12Months),
      partial: !summary.last12Months.complete,
    },
    {
      label: `${year - 1} total`,
      value: countLabel(summary.lastYear),
      note: 'Previous calendar year',
      partial: !summary.lastYear.complete,
    },
    {
      label: 'Active demos',
      value: number(report.active),
      note: `${number(report.deleting)} awaiting cleanup`,
    },
  ]
  const reportStale = now - report.generatedAt > 30 * 60 * 1000
  return (
    <>
      <div className="space-y-2 text-sm text-text-2">
        <p>
          Report updated {timestampLabel(report.generatedAt)}. All reporting periods use UTC; today
          is still in progress.
        </p>
        {reportStale && (
          <p role="status" className="text-danger">
            This report is over 30 minutes old. New demos and usage may not be reflected yet.
          </p>
        )}
        <p>
          {report.trackingStartedAt === null
            ? 'Demo history has not started recording yet.'
            : `Recording began ${timestampLabel(report.trackingStartedAt)}.`}{' '}
          Earlier demos that had already been deleted cannot be recovered. Incomplete periods show
          only recorded demos.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile) => (
          <AdminStat
            key={tile.label}
            label={tile.label}
            value={tile.value}
            note={tile.note}
            detail={tile.partial ? 'Full-period history unavailable' : undefined}
          />
        ))}
      </div>
      <DemoCreationChart report={report} period={period} onPeriodChange={setPeriod} />
      <Audience report={report} period={period} />
      <Storage report={report} />
      <CostEstimate report={report} />
    </>
  )
}

export function DemoCreationChart({
  report,
  period: controlledPeriod,
  onPeriodChange,
  showFreshness = false,
}: {
  report: DemoMetricsReport
  period?: DemoChartPeriod
  onPeriodChange?: (period: DemoChartPeriod) => void
  showFreshness?: boolean
}) {
  const [uncontrolledPeriod, setUncontrolledPeriod] = useState<DemoChartPeriod>('30d')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!showFreshness) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [showFreshness])
  const period = controlledPeriod ?? uncontrolledPeriod
  const setPeriod = onPeriodChange ?? setUncontrolledPeriod
  const series = demoCreationSeries(report, period)
  const rows: ChartRow[] = series.map(({ current, previous }) => ({
    key: current.start,
    label: periodLabel(current),
    shortLabel: period === '12m' ? dateLabel(current.start, true) : dateLabel(current.start),
    value: current.value,
    partial: !current.complete,
    comparison: previous.value,
    comparisonPartial: !previous.complete,
    comparisonLabel: periodLabel(previous),
  }))
  const comparisonLabels = {
    current: `Current period: ${dateLabel(series[0].current.start)} – ${dateLabel(series.at(-1).current.end)}`,
    previous: `Previous period: ${dateLabel(series[0].previous.start)} – ${dateLabel(series.at(-1).previous.end)}`,
  }
  const stale = showFreshness && now - report.generatedAt > 30 * 60 * 1000
  return (
    <Card className="gap-5 p-5 shadow-card sm:p-6">
      <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
        <div>
          <h2 className="text-md font-semibold">Demo workspaces created</h2>
          <p className="mt-1 text-sm text-text-2">
            Compare the selected period with the preceding period.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="demo-chart-period">Period</Label>
          <NativeSelect
            id="demo-chart-period"
            value={period}
            onChange={(event) => setPeriod(event.target.value as DemoChartPeriod)}
          >
            <NativeSelectOption value="7d">Last 7 days</NativeSelectOption>
            <NativeSelectOption value="30d">Last 30 days</NativeSelectOption>
            <NativeSelectOption value="12m">Last 12 months</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      {showFreshness && (
        <div className="space-y-1 text-xs text-text-2">
          <p>
            Report updated {timestampLabel(report.generatedAt)}. All reporting periods use UTC;
            today is still in progress.
          </p>
          {stale && (
            <p role="status" className="text-danger">
              This report is over 30 minutes old. New demos may not be reflected yet.
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-text-2">
        {period === '12m'
          ? 'Monthly totals compared with the preceding 12 calendar months. The current month is still in progress; its comparison is a full month.'
          : `Daily totals compared with the preceding ${period === '7d' ? 7 : 30} days. Today is still in progress; its comparison is a full day.`}{' '}
        Dashed outlines mark incomplete history. Missing history stays blank.
      </p>
      <MetricsChart
        key={period}
        rows={rows}
        label="Demo workspaces created"
        format={number}
        comparisonLabels={comparisonLabels}
      />
    </Card>
  )
}

type ChartRow = {
  key: string
  label: string
  shortLabel: string
  value: number | null
  detail?: string
  partial?: boolean
  comparison?: number | null
  comparisonPartial?: boolean
  comparisonLabel?: string
}

function Audience({ report, period }: { report: DemoMetricsReport; period: DemoChartPeriod }) {
  const audience =
    report.audience[
      period === '7d' ? 'last7Days' : period === '30d' ? 'last30Days' : 'last12Months'
    ]
  const label =
    period === '7d' ? 'Last 7 days' : period === '30d' ? 'Last 30 days' : 'Last 12 months'
  const countryNames = new Intl.DisplayNames(undefined, { type: 'region' })
  const countryLabel = (name: string) => (name === 'ZZ' ? 'Unknown' : countryNames.of(name) || name)
  return (
    <Card className="gap-5 p-5 shadow-card sm:p-6">
      <div>
        <h2 className="text-md font-semibold">Demo visitors</h2>
        <p className="mt-2 text-sm text-text-2">
          {label}, using the period selected above. One entry per created workspace; this does not
          count unique people or all website visits.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {[
          { title: 'Browser', rows: audience.browsers, name: (name: string) => name },
          {
            title: 'Operating system',
            rows: audience.operatingSystems,
            name: (name: string) => name,
          },
          { title: 'Country', rows: audience.countries, name: countryLabel },
        ].map((group) => {
          const total = group.rows.reduce((sum, row) => sum + row.count, 0)
          const rows = [...group.rows].sort(
            (a, b) => b.count - a.count || a.name.localeCompare(b.name),
          )
          return (
            <section
              key={group.title}
              className="min-w-0 rounded-md border border-border bg-surface-2 p-4"
            >
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <p className="mt-1 mb-3 text-xs text-text-2">{number(total)} recorded demos</p>
              {total === 0 ? (
                <p className="text-sm text-text-2">No visitor details recorded for this period.</p>
              ) : (
                <div className="max-h-72 overflow-auto pr-1">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      {group.title} of demos created, {label.toLowerCase()}
                    </caption>
                    <thead className="sr-only">
                      <tr>
                        <th scope="col">{group.title}</th>
                        <th scope="col">Demos</th>
                        <th scope="col">Share of recorded demos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <th scope="row" className="w-full py-2 pr-3 text-left font-normal">
                            <span>{group.name(row.name)}</span>
                            <svg
                              viewBox="0 0 100 4"
                              className="mt-1 block h-1 w-full"
                              role="img"
                              aria-label={`${((row.count / total) * 100).toFixed(1)} percent`}
                            >
                              <rect width={100} height={4} rx={2} fill="var(--surface-3)" />
                              <rect
                                width={(row.count / total) * 100}
                                height={4}
                                rx={2}
                                fill="var(--primary)"
                              />
                            </svg>
                          </th>
                          <td className="px-1 py-2 text-right align-top tabular-nums">
                            {number(row.count)}
                          </td>
                          <td className="py-2 pl-2 text-right align-top text-text-2 tabular-nums">
                            {((row.count / total) * 100).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}
      </div>
      <p className="text-xs text-text-2">
        Percentages use recorded demos, including Unknown. Earlier demos may lack these details.
        Country is approximate; browsers, privacy settings and VPNs can affect these reports.
      </p>
    </Card>
  )
}

export function MetricsChart({
  rows,
  label,
  format,
  line = false,
  comparisonLabels,
  valueColumnLabel,
}: {
  rows: ChartRow[]
  label: string
  format: (value: number) => string
  line?: boolean
  comparisonLabels?: { current: string; previous: string }
  valueColumnLabel?: string
}) {
  const id = useId()
  const [focus, setFocus] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const targets = useRef<(SVGGElement | null)[]>([])
  const selected = rows[hover ?? focus]
  const compared = rows.some((row) => row.comparison !== undefined)
  const width = 800,
    height = 220,
    left = 72,
    bottom = 188,
    top = 18
  const slot = (width - left) / rows.length
  const maximum = Math.max(1, ...rows.flatMap((row) => [row.value ?? 0, row.comparison ?? 0]))
  const y = (value: number) => bottom - (value / maximum) * (bottom - top)
  const x = (index: number) => left + (index + 0.5) * slot
  const barWidth = Math.min(24, slot * (compared ? 0.32 : 0.65))
  const valueLabel = (row: ChartRow) =>
    row.value === null
      ? 'Unavailable'
      : `${format(row.value)}${row.partial ? ' (partial history)' : ''}`
  const comparisonValueLabel = (row: ChartRow) =>
    row.comparison == null
      ? 'Unavailable'
      : `${format(row.comparison)}${row.comparisonPartial ? ' (partial history)' : ''}`
  const description = (row: ChartRow) =>
    `${compared ? 'Current period, ' : ''}${row.label}: ${valueLabel(row)}${row.detail ? `; ${row.detail}` : ''}${compared ? `; Previous period, ${row.comparisonLabel}: ${comparisonValueLabel(row)}` : ''}`
  // A new move command after every missing sample deliberately breaks the line.
  const path = rows
    .map((row, index) =>
      row.value === null
        ? ''
        : `${index > 0 && rows[index - 1].value !== null ? 'L' : 'M'}${x(index)},${y(row.value)}`,
    )
    .join(' ')
  return (
    <div className="min-w-0">
      {compared && (
        <div
          className="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-text-2"
          data-demo-comparison-legend
        >
          <span className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-0.5 size-3 shrink-0 rounded-sm bg-primary" />
            {comparisonLabels?.current ?? 'Current period'} (left bars)
          </span>
          <span className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-0.5 size-3 shrink-0 bg-warning" />
            {comparisonLabels?.previous ?? 'Previous period'} (right bars)
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        {/* biome-ignore lint/a11y/useSemanticElements: An interactive SVG group cannot be replaced by an HTML fieldset. */}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full min-w-[720px]"
          role="group"
          aria-label={label}
          aria-describedby={id}
        >
          {[...new Set([0, line ? maximum / 2 : Math.ceil(maximum / 2), maximum])].map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                fontSize={11}
                fill="var(--text-2)"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          {line && <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} />}
          {rows.map((row, index) => (
            <g key={row.key}>
              {row.comparison != null && (
                <rect
                  data-series="previous"
                  x={x(index) + 1}
                  y={y(row.comparison)}
                  width={barWidth}
                  height={Math.max(0, bottom - y(row.comparison))}
                  fill="var(--warn)"
                  fillOpacity={row.comparisonPartial ? 0.35 : 1}
                  stroke={row.comparisonPartial ? 'var(--warn)' : 'none'}
                  strokeWidth={1.5}
                  strokeDasharray={row.comparisonPartial ? '3 2' : undefined}
                />
              )}
              {row.value !== null &&
                (line ? (
                  <circle
                    cx={x(index)}
                    cy={y(row.value)}
                    r={hover === index || focus === index ? 4 : 2.5}
                    fill="var(--primary)"
                  />
                ) : (
                  <rect
                    data-series="current"
                    x={x(index) - (compared ? barWidth + 1 : barWidth / 2)}
                    y={y(row.value)}
                    width={barWidth}
                    height={Math.max(0, bottom - y(row.value))}
                    rx={2}
                    fill="var(--primary)"
                    fillOpacity={row.partial ? 0.35 : 1}
                    stroke={row.partial ? 'var(--primary)' : 'none'}
                    strokeWidth={1.5}
                    strokeDasharray={row.partial ? '3 2' : undefined}
                  />
                ))}
              {(rows.length <= 12 || index % 5 === 0 || index === rows.length - 1) && (
                <text
                  x={index === rows.length - 1 ? width - 4 : x(index)}
                  y={height - 8}
                  textAnchor={index === rows.length - 1 ? 'end' : 'middle'}
                  fontSize={10}
                  fill="var(--text-2)"
                >
                  {row.shortLabel}
                </text>
              )}
              {/* biome-ignore lint/a11y/useSemanticElements: SVG data points need button semantics; HTML buttons cannot be SVG children. */}
              <g
                ref={(node) => {
                  targets.current[index] = node
                }}
                role="button"
                tabIndex={index === focus ? 0 : -1}
                aria-label={description(row)}
                className="outline-none focus-visible:stroke-ring"
                onFocus={() => {
                  setFocus(index)
                  setHover(null)
                }}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover(null)}
                onClick={() => {
                  setFocus(index)
                  targets.current[index]?.focus()
                }}
                onKeyDown={(event) => {
                  let next = index
                  if (event.key === 'ArrowRight') next = Math.min(rows.length - 1, index + 1)
                  else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
                  else if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = rows.length - 1
                  else if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setFocus(next)
                  targets.current[next]?.focus()
                }}
              >
                <rect
                  x={left + index * slot}
                  y={top - 6}
                  width={slot}
                  height={bottom - top + 12}
                  fill="transparent"
                  strokeWidth={2}
                />
              </g>
            </g>
          ))}
        </svg>
      </div>
      <p id={id} role="status" className="min-h-10 text-sm text-text-2">
        {selected && description(selected)}
      </p>
      <p className="mb-2 text-xs text-text-2">
        Hover or focus the graph for values. Use left and right arrow keys to move between dates.
      </p>
      <p className="mb-2 text-xs text-text-2 sm:hidden">
        Swipe across the graph to see more dates, or open the data table below.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer py-2 font-medium">View data table</summary>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="p-2">
                  Period (UTC)
                </th>
                <th scope="col" className="p-2">
                  {valueColumnLabel ??
                    (line ? 'Average stored' : compared ? 'Current period' : 'Created')}
                </th>
                {compared && (
                  <th scope="col" className="p-2">
                    Previous period
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border">
                  <th scope="row" className="p-2 font-normal">
                    {row.label}
                  </th>
                  <td className="p-2 tabular-nums">
                    {valueLabel(row)}
                    {row.detail && <span className="block text-xs text-text-2">{row.detail}</span>}
                  </td>
                  {compared && (
                    <td className="p-2 tabular-nums">
                      {comparisonValueLabel(row)}
                      <span className="block text-xs text-text-2">{row.comparisonLabel}</span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function Storage({ report }: { report: DemoMetricsReport }) {
  const storage = report.storage
  const stale = storage && Date.now() - storage.sampledAt > DEMO_STORAGE_STALE_MS
  const rows = demoStorageSeries(report).map((row) => ({
    key: row.date,
    label: `${dateLabel(row.date)} (${number(row.samples)} samples)`,
    shortLabel: dateLabel(row.date),
    value: row.databaseBytes === null ? null : row.databaseBytes + row.fileBytes,
  }))
  return (
    <Card className="gap-4 p-5 shadow-card sm:p-6">
      <h2 className="text-md font-semibold">Demo storage</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'App database, approximate', value: storage?.databaseBytes },
          { label: 'Uploaded files', value: storage?.fileBytes },
          {
            label: 'Total measured',
            value: storage ? storage.databaseBytes + storage.fileBytes : undefined,
          },
        ].map((tile) => (
          <div key={tile.label} className="rounded-md border border-border bg-surface-2 p-4">
            <p className="text-sm text-text-2">{tile.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {tile.value === undefined ? 'Unavailable' : fmtDemoBytes(tile.value)}
            </p>
          </div>
        ))}
      </div>
      <p className="text-sm text-text-2">
        {storage
          ? `Sampled ${timestampLabel(storage.sampledAt)}. Samples are collected hourly.`
          : 'Waiting for the first hourly storage sample.'}{' '}
        {stale && <span className="text-danger">This sample is over 2 hours old.</span>}
      </p>
      <p className="text-xs text-text-2">
        Daily average database and file storage for the last 30 days. Gaps mean no sample, not zero
        usage. Storage units follow Convex’s dashboard (1 GB = 1,073,741,824 bytes).
      </p>
      <MetricsChart rows={rows} label="Daily average demo storage" format={fmtDemoBytes} line />
    </Card>
  )
}

function CostEstimate({ report }: { report: DemoMetricsReport }) {
  const [settings, setSettings] = useState<DemoCostSettings>(() => {
    try {
      return readDemoCostSettings(localStorage.getItem(COST_KEY))
    } catch {
      return { ...DEFAULT_DEMO_COST_SETTINGS }
    }
  })
  const [saved, setSaved] = useState(true)
  const { basis, cost } = estimateDemoMonthlyCost(report, settings)
  const save = (next: DemoCostSettings) => {
    setSettings(next)
    try {
      localStorage.setItem(COST_KEY, JSON.stringify(next))
      setSaved(true)
    } catch {
      setSaved(false)
    }
  }
  const change = (field: keyof DemoCostSettings, value: string) =>
    save({ ...settings, [field]: value })
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: settings.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(value)
  return (
    <Card className="gap-5 p-5 shadow-card sm:p-6">
      <div>
        <h2 className="text-md font-semibold">Estimated monthly cost</h2>
        <p className="mt-2 text-sm text-text-2">
          A full month of storage at the average usage measured so far this month. Default prices
          use Convex Professional rates for Europe: USD {DEFAULT_DEMO_COST_SETTINGS.databasePrice} /
          GB for database storage and USD {DEFAULT_DEMO_COST_SETTINGS.filePrice} / GB for files per
          month. You can adjust them below.
        </p>
        <p className="mt-2 text-xs text-text-2">
          <a
            className="underline underline-offset-2"
            href={DEMO_CONVEX_PRICING_SOURCE}
            target="_blank"
            rel="noreferrer"
          >
            Convex pricing
          </a>{' '}
          checked {dateLabel(DEMO_CONVEX_PRICING_CHECKED_AT)}.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="demo-currency">Currency code</Label>
          <Input
            id="demo-currency"
            value={settings.currency}
            maxLength={3}
            placeholder="USD"
            onChange={(event) => change('currency', event.target.value.toUpperCase())}
            aria-invalid={!/^[A-Z]{3}$/.test(settings.currency)}
          />
          <p className="text-xs text-text-2">For example: USD, EUR or NOK</p>
        </div>
        {(
          [
            ['databasePrice', 'Database / GB / month'],
            ['filePrice', 'Files / GB / month'],
            ['otherMonthly', 'Other monthly costs (optional)'],
          ] as const
        ).map(([field, label]) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`demo-${field}`}>{label}</Label>
            <Input
              id={`demo-${field}`}
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={settings[field]}
              placeholder={field === 'otherMonthly' ? 'Not included' : 'Enter price'}
              onChange={(event) => change(field, event.target.value)}
              aria-invalid={!!settings[field].trim() && parseDemoPrice(settings[field]) === null}
            />
          </div>
        ))}
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            save({
              ...DEFAULT_DEMO_COST_SETTINGS,
              otherMonthly: settings.currency === 'USD' ? settings.otherMonthly : '',
            })
          }
        >
          Use Convex Professional EU rates
        </Button>
      </div>
      <p className="text-xs text-text-2">
        {saved
          ? 'Your price changes are saved only in this browser.'
          : 'Browser storage is unavailable. Prices will last only while this page stays open.'}{' '}
        Enter nonnegative prices in the same currency; enter 0 for a price with no charge. Changing
        the currency code does not convert the prices. Restoring Convex rates selects USD and clears
        other monthly costs entered in another currency.
      </p>
      <div className="rounded-md border border-border bg-surface-2 p-4">
        <p className="text-sm text-text-2">Monthly run rate</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums" data-demo-cost-total>
          {cost ? money(cost.total) : 'Unavailable'}
        </p>
        <p className="mt-2 text-sm text-text-2">
          {cost
            ? `Database ${money(cost.database)} + files ${money(cost.files)} + other ${money(cost.other)}.`
            : basis.samples
              ? 'Enter valid database and file prices to calculate an estimate.'
              : 'Waiting for storage samples from this month.'}
        </p>
      </div>
      <p className="text-sm text-text-2">
        Basis: {number(basis.samples)} samples across {basis.sampledDays} of {basis.elapsedDays}{' '}
        elapsed UTC days, {dateLabel(basis.start)} – {dateLabel(basis.end)}.{' '}
        {basis.samples > 0 &&
          `Average storage: ${fmtDemoBytes(basis.databaseBytes)} database and ${fmtDemoBytes(basis.fileBytes)} files, weighted by sample count.`}{' '}
        Unsampled time is unknown; this is a projection, not an actual bill.
      </p>
      <p className="text-xs text-text-2">
        Approximate storage cost before included allowances, which are shared across your Convex
        team. Database size excludes authentication records and index overhead; backup storage is
        not measured. Bandwidth, compute, the base plan and other charges are excluded unless you
        add them under other monthly costs. Prices apply to the full measured volume using the GB
        units displayed by Convex’s dashboard; this does not calculate the remaining free allowance
        or tiered rates.
      </p>
    </Card>
  )
}
