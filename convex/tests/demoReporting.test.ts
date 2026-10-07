import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import { type DemoMetricsReport, parseDemoMetricsReport } from '../lib/demoMetricsReport'
import { DEMO_REPORT_MAX_BYTES, demoMetricsDestination } from '../lib/demoReporting'
import { as, expectRefusal, newT, type T, withOrg } from './helpers.setup'

const SECRET = 'reporting-test-secret-0123456789abcdef'
const NOW = Date.parse('2026-09-15T10:00:00Z')
const emptyAudience = { browsers: [], operatingSystems: [], countries: [] }
function report(): DemoMetricsReport {
  return {
    version: 1,
    generatedAt: NOW,
    trackingStartedAt: NOW - 86_400_000,
    historyCompleteSince: NOW - 86_400_000,
    totalCreated: 3,
    active: 2,
    deleting: 1,
    counts: [{ date: '2026-09-15', created: 3 }],
    storage: { sampledAt: NOW - 1000, databaseBytes: 2048, fileBytes: 4096 },
    storageDaily: [{ date: '2026-09-15', samples: 1, databaseBytesSum: 2048, fileBytesSum: 4096 }],
    audience: { last7Days: emptyAudience, last30Days: emptyAudience, last12Months: emptyAudience },
  }
}
type HttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  duplex?: 'half'
}
declare const ReadableStream: {
  new (source: {
    pull(controller: { enqueue(value: Uint8Array): void; close(): void }): void
    cancel(): void
  }): unknown
}
const post = (t: T, body: unknown, authorization: string | null = `Bearer ${SECRET}`) =>
  (t as unknown as { fetch(path: string, init: HttpInit): Promise<Response> }).fetch(
    '/internal/demo-metrics',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
    },
  )
const receive = makeFunctionReference<'mutation', { payload: string }, null>(
  'demoReporting:receive',
)
const publish = makeFunctionReference<'action', Record<string, never>, null>(
  'demoReporting:publish',
)

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubEnv('APP_MODE', 'normal')
  vi.stubEnv('SITE_URL', 'http://localhost:5199')
  vi.stubEnv('DEMO_METRICS_SECRET', SECRET)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('aggregate demo report transport', () => {
  it('requires its dedicated secret before accepting a report, independently of app credentials', async () => {
    const t = newT()
    expect((await post(t, report(), null)).status).toBe(401)
    expect((await post(t, report(), 'Bearer app-or-demo-login')).status).toBe(401)
    expect((await post(t, report(), `Bearer ${SECRET}extra`)).status).toBe(401)
    expect(await t.run((ctx) => ctx.db.query('demo_metric_reports').collect())).toEqual([])
    const response = await post(t, report())
    expect(response.status).toBe(204)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('keeps reporting closed when configuration is missing and on the demo backend itself', async () => {
    const t = newT()
    vi.stubEnv('DEMO_METRICS_SECRET', '')
    expect((await post(t, report())).status).toBe(404)
    vi.stubEnv('DEMO_METRICS_SECRET', SECRET)
    vi.stubEnv('APP_MODE', 'demo')
    expect((await post(t, report())).status).toBe(404)
  })

  it('stops and cancels an oversized chunked request without consuming its remaining body', async () => {
    const t = newT()
    let chunks = 0
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        chunks++
        controller.enqueue(new Uint8Array(DEMO_REPORT_MAX_BYTES / 2 + 1))
        if (chunks === 20) controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await (
      t as unknown as { fetch(path: string, init: HttpInit): Promise<Response> }
    ).fetch('/internal/demo-metrics', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    })
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    // Streams may prefetch one extra chunk while the handler processes one.
    expect(chunks).toBeLessThanOrEqual(3)
    expect(await t.run((ctx) => ctx.db.query('demo_metric_reports').collect())).toEqual([])
  })

  it('rejects contradictory timelines without replacing a previously accepted report', async () => {
    const t = newT()
    expect((await post(t, report())).status).toBe(204)
    for (const invalid of [
      { ...report(), generatedAt: NOW + 1, historyCompleteSince: NOW - 2 * 86_400_000 },
      { ...report(), generatedAt: NOW + 1, historyCompleteSince: NOW + 2 },
      { ...report(), generatedAt: NOW + 1, trackingStartedAt: null },
      { ...report(), generatedAt: NOW + 1, storage: { ...report().storage!, sampledAt: NOW + 2 } },
      { ...report(), generatedAt: NOW + 1, counts: [{ date: '2026-09-16', created: 1 }] },
      {
        ...report(),
        generatedAt: NOW + 1,
        storageDaily: [{ ...report().storageDaily[0], date: '2026-09-16' }],
      },
    ])
      expect((await post(t, invalid)).status).toBe(400)
    const saved = await t.run((ctx) => ctx.db.query('demo_metric_reports').unique())
    expect(JSON.parse(saved!.payload)).toEqual(report())
  })

  it('projects aggregate fields, rejects invalid data and preserves a newer report against late delivery', async () => {
    const t = newT()
    expect((await post(t, { ...report(), totalCreated: -1 })).status).toBe(400)
    expect((await post(t, { ...report(), generatedAt: NOW + 6 * 60_000 })).status).toBe(400)
    expect((await post(t, { ...report(), privateOrg: { title: 'must not persist' } })).status).toBe(
      204,
    )
    await t.mutation(receive, {
      payload: JSON.stringify({ ...report(), generatedAt: NOW - 1000, totalCreated: 1 }),
    })
    const rows = await t.run((ctx) => ctx.db.query('demo_metric_reports').collect())
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toEqual(report())
    expect(rows[0].generated_at).toBe(NOW)
    expect(rows[0].received_at).toBe(NOW)
  })

  it('allows only platform operators to read cached analytics', async () => {
    const t = newT(),
      fixture = await withOrg(t)
    await t.mutation(receive, { payload: JSON.stringify(report()) })
    await expectRefusal(t.query(api.adminDemo.metrics, {}), 'forbidden', /not signed in/)
    await expectRefusal(
      as(t, fixture.admin).query(api.adminDemo.metrics, {}),
      'forbidden',
      /not a platform operator/,
    )
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: fixture.admin.auth_user_id!,
        note: 'analytics test',
        created_at: new Date(NOW).toISOString(),
      }),
    )
    expect(await as(t, fixture.admin).query(api.adminDemo.metrics, {})).toEqual({
      status: 'ready',
      report: report(),
    })
    vi.stubEnv('APP_MODE', 'demo')
    await expectRefusal(
      as(t, fixture.admin).query(api.adminDemo.metrics, {}),
      'forbidden',
      /regular workspace/,
    )
  })

  it('distinguishes disconnected reporting from genuine zero usage', async () => {
    const t = newT(),
      fixture = await withOrg(t)
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', {
        auth_user_id: fixture.admin.auth_user_id!,
        note: 'test',
        created_at: new Date(NOW).toISOString(),
      }),
    )
    const op = as(t, fixture.admin)
    expect((await op.query(api.adminDemo.metrics, {})).status).toBe('not_configured')
    vi.stubEnv('DEMO_METRICS_SECRET', '')
    expect((await op.query(api.adminDemo.metrics, {})).status).toBe('not_configured')
  })

  it('publishes only from the demo, with a secret and destination, using aggregate data', async () => {
    const t = newT(),
      request = vi.fn().mockResolvedValue({ status: 204 })
    vi.stubGlobal('fetch', request)
    vi.stubEnv('DEMO_METRICS_DESTINATION_URL', 'https://api.qivo.io')
    await t.action(publish, {})
    expect(request).not.toHaveBeenCalled()
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
    await t.action(publish, {})
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://api.qivo.io/internal/demo-metrics')
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.redirect).toBe('error')
    expect(parseDemoMetricsReport(JSON.parse(init.body)).totalCreated).toBe(0)
    vi.stubEnv('DEMO_METRICS_SECRET', '')
    await t.action(publish, {})
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('report parsing and destination validation', () => {
  it('rejects impossible dates, duplicate days and unbounded labels', () => {
    expect(() =>
      parseDemoMetricsReport({ ...report(), counts: [{ date: '2026-02-30', created: 1 }] }),
    ).toThrow()
    expect(() =>
      parseDemoMetricsReport({ ...report(), counts: [...report().counts, ...report().counts] }),
    ).toThrow()
    expect(() => parseDemoMetricsReport({ ...report(), active: Infinity })).toThrow()
    expect(() =>
      parseDemoMetricsReport({
        ...report(),
        storageDaily: [{ ...report().storageDaily[0], samples: 0 }],
      }),
    ).toThrow()
    const audience = { ...emptyAudience, countries: [{ name: 'Norway', count: 1 }] }
    expect(() =>
      parseDemoMetricsReport({
        ...report(),
        audience: { last7Days: audience, last30Days: emptyAudience, last12Months: emptyAudience },
      }),
    ).toThrow()
  })

  it('permits local development transfer, and refuses insecure or unrelated production destinations', () => {
    vi.stubEnv('DEMO_METRICS_DESTINATION_URL', 'http://localhost:3211')
    expect(demoMetricsDestination()).toBe('http://localhost:3211/internal/demo-metrics')
    vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
    expect(() => demoMetricsDestination()).toThrow()
    for (const url of [
      'http://api.qivo.io',
      'https://api.qivo.io.evil.test',
      'https://api.qivo.io@evil.test',
      'https://evil.test',
      'https://api.qivo.io/path',
    ]) {
      vi.stubEnv('DEMO_METRICS_DESTINATION_URL', url)
      expect(() => demoMetricsDestination()).toThrow()
    }
    vi.stubEnv('DEMO_METRICS_DESTINATION_URL', 'https://greedy-minnow-935.eu-west-1.convex.site')
    expect(demoMetricsDestination()).toBe(
      'https://greedy-minnow-935.eu-west-1.convex.site/internal/demo-metrics',
    )
  })
})
