import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { marketingId } from '../internal/marketingDemoData'
import type { DemoMetricsReport } from '../lib/demoMetricsReport'
import {
  DEMO_STORAGE_TABLES,
  demoMetricsSnapshot,
  estimateDocumentBytes,
  recordDemoCreated,
  recordStorageSample,
  retainedSince,
} from '../model/demoMetrics'
import { expectRefusal, newT, type T, uuid } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}
const NOW = Date.parse('2026-09-16T10:00:00Z')
const sample = makeFunctionReference<'mutation', Record<string, never>, null>(
  'internal/demoMetrics:sample',
)
const samplePage = makeFunctionReference<'mutation', { run_id: string; step: number }, null>(
  'internal/demoMetrics:samplePage',
)
const snapshot = makeFunctionReference<'query', Record<string, never>, DemoMetricsReport>(
  'internal/demoMetrics:snapshot',
)
const purge = makeFunctionReference<'mutation', { demo_id: string }, null>(
  'internal/demoCleanup:purge',
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site')
  vi.stubEnv('BETTER_AUTH_SECRET', 'demo-metrics-hermetic-test-secret-314159')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function receipt(t: T, fields: Partial<WithoutSystemFields<Doc<'demo_sessions'>>> = {}) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert('demo_sessions', {
      id: uuid(),
      auth_user_id: uuid(),
      org_id: uuid(),
      created_at: NOW,
      expires_at: NOW + 86_400_000,
      status: 'ready',
      seed_version: 1,
      ...fields,
    })
    return (await ctx.db.get(id))!
  })
}

const scan = (t: T) => t.run((ctx) => ctx.db.query('demo_metrics_scans').first())
async function finishSample(t: T) {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(await scan(t)).toBeNull()
  return t.query(snapshot, {})
}

describe('durable demo creation analytics', () => {
  it('does not invent history before the tracker starts or initialize during a report read', async () => {
    const t = newT()
    const report = await t.query(snapshot, {})
    expect(report).toMatchObject({
      trackingStartedAt: null,
      historyCompleteSince: null,
      totalCreated: 0,
      counts: [],
      storage: null,
      storageDaily: [],
    })
    expect(await t.run((ctx) => ctx.db.query('demo_metrics').collect())).toEqual([])
  })

  it('counts real successful provisioning once across retries, and ignores abandoned logins', async () => {
    const t = newT()
    t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
    const user = await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'user',
          data: {
            name: 'Anonymous',
            email: `${uuid()}@demo.invalid`,
            emailVerified: false,
            isAnonymous: true,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      }),
    )
    const session = await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'session',
          data: {
            userId: user._id as string,
            token: uuid(),
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt: NOW + 86_400_000,
          },
        },
      }),
    )
    const pending = await receipt(t, {
      auth_user_id: user._id as string,
      status: 'unprovisioned',
      org_id: undefined,
      seed_version: undefined,
      visitor_browser: 'Safari',
      visitor_os: 'iOS',
      visitor_country: 'NO',
    })
    await t.run((ctx) => recordDemoCreated(ctx, pending._id))
    expect((await t.query(snapshot, {})).totalCreated).toBe(0)
    const visitor = t.withIdentity({
      subject: user._id as string,
      sessionId: session._id as string,
    })
    expect((await visitor.mutation(api.demo.ensureMine, {})).status).toBe('ready')
    await visitor.mutation(api.demo.ensureMine, {})
    await t.run((ctx) => recordDemoCreated(ctx, pending._id))
    expect(await t.query(snapshot, {})).toMatchObject({
      totalCreated: 1,
      active: 1,
      counts: [{ date: '2026-09-16', created: 1 }],
      audience: {
        last7Days: {
          browsers: [{ name: 'Safari', count: 1 }],
          operatingSystems: [{ name: 'iOS', count: 1 }],
          countries: [{ name: 'NO', count: 1 }],
        },
      },
    })
  })

  it('rolls the count and receipt marker back together if provisioning does not commit', async () => {
    const t = newT()
    const pending = await receipt(t)
    await expect(
      t.run(async (ctx) => {
        await recordDemoCreated(ctx, pending._id)
        throw new Error('Provisioning rolled back')
      }),
    ).rejects.toThrow('Provisioning rolled back')
    expect((await t.query(snapshot, {})).totalCreated).toBe(0)
    expect((await t.run((ctx) => ctx.db.get(pending._id)))?.metrics_counted_at).toBeUndefined()
  })

  it('backfills existing successful receipts in bounded pages without claiming earlier completeness', async () => {
    const t = newT()
    for (let i = 0; i < 70; i++)
      await receipt(t, { created_at: Date.parse('2026-09-15T23:59:59Z') })
    await receipt(t, { status: 'unprovisioned', org_id: undefined, seed_version: undefined })
    await sampleRun(t)
    const report = await t.query(snapshot, {})
    expect(report.totalCreated).toBe(70)
    expect(report.trackingStartedAt).toBe(NOW)
    expect(report.historyCompleteSince).toBe(NOW)
    expect(report.counts.find((row) => row.date === '2026-09-15')?.created).toBe(70)
    expect(report.audience.last7Days.countries).toEqual([{ name: 'ZZ', count: 70 }])
    await sampleRun(t)
    expect((await t.query(snapshot, {})).totalCreated).toBe(70)
  })

  it('preserves recovered creation totals and audience after the receipt is purged', async () => {
    const t = newT()
    t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
    const id = uuid()
    const old = await receipt(t, {
      id,
      org_id: await marketingId(`public-demo:${id}`, 'org'),
      created_at: Date.parse('2026-09-15T23:59:59Z'),
      status: 'deleting',
      cleanup_phase: 'finish',
      visitor_browser: 'Firefox',
      visitor_country: 'SE',
    })
    await t.mutation(purge, { demo_id: old.id })
    await t.mutation(purge, { demo_id: old.id })
    expect(await t.run((ctx) => ctx.db.get(old._id))).toBeNull()
    expect(await t.query(snapshot, {})).toMatchObject({
      totalCreated: 1,
      active: 0,
      deleting: 0,
      counts: [{ date: '2026-09-15', created: 1 }],
      historyCompleteSince: NOW,
      audience: { last7Days: { countries: [{ name: 'SE', count: 1 }] } },
    })
  })

  it('uses matching UTC audience windows and keeps expired storage days out of the report', async () => {
    const t = newT()
    for (const [date, country] of [
      ['2026-09-10T00:00:00Z', 'NO'],
      ['2026-09-09T23:59:59Z', 'SE'],
      ['2026-08-18T00:00:00Z', 'DK'],
      ['2026-08-17T23:59:59Z', 'FI'],
      ['2025-10-01T00:00:00Z', 'US'],
      ['2025-09-30T23:59:59Z', 'GB'],
    ]) {
      const row = await receipt(t, { created_at: Date.parse(date), visitor_country: country })
      await t.run((ctx) => recordDemoCreated(ctx, row._id))
    }
    const report = await t.query(snapshot, {})
    expect(report.audience.last7Days.countries.map((row) => row.name)).toEqual(['NO'])
    expect(report.audience.last30Days.countries.map((row) => row.name)).toEqual(['DK', 'NO', 'SE'])
    expect(report.audience.last12Months.countries.map((row) => row.name)).toEqual([
      'DK',
      'FI',
      'NO',
      'SE',
      'US',
    ])
    expect(report.totalCreated).toBe(6)
  })
})

async function sampleRun(t: T) {
  await t.mutation(sample, {})
  return finishSample(t)
}

describe('bounded demo storage sampling', () => {
  it('is disabled outside demo deployments and refuses a demo pointed at the main app', async () => {
    const t = newT()
    vi.stubEnv('APP_MODE', 'normal')
    await t.mutation(sample, {})
    expect(await scan(t)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('demo_metrics').collect())).toEqual([])
    await expectRefusal(t.query(snapshot, {}), 'forbidden', /unavailable/)
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('SITE_URL', 'https://qivo.io')
    await expectRefusal(t.mutation(sample, {}), 'forbidden', /main deployment/)
  })

  it('measures every document page with UTF-8 bytes and every stored file by its exact size', async () => {
    const t = newT()
    await t.run(async (ctx) => {
      for (let i = 0; i < 129; i++) {
        await ctx.db.insert('demo_admission', { key: `${i}💛æ`, count: i, expires_at: NOW })
        await ctx.storage.store(new Blob(['💛']) as never)
      }
    })
    await t.mutation(sample, {})
    const expectedBytes = await t.run(async (ctx) => {
      let bytes = 0
      for (const table of DEMO_STORAGE_TABLES)
        for (const row of await ctx.db.query(table).collect()) bytes += estimateDocumentBytes(row)
      return bytes
    })
    expect(estimateDocumentBytes({ text: '💛æ' })).toBe(JSON.stringify({ text: '💛æ' }).length + 3)
    const report = await finishSample(t)
    expect(report.storage).toEqual({
      sampledAt: NOW,
      databaseBytes: expectedBytes,
      fileBytes: 129 * 4,
    })
    expect(report.storageDaily).toEqual([
      { date: '2026-09-16', samples: 1, databaseBytesSum: expectedBytes, fileBytesSum: 129 * 4 },
    ])
  })

  it('fences repeated page delivery and resumes a stalled scan without double-counting its pages', async () => {
    const t = newT()
    await t.mutation(sample, {})
    const initial = (await scan(t))!
    await t.mutation(samplePage, { run_id: initial.run_id, step: initial.step })
    const advanced = (await scan(t))!
    await t.mutation(samplePage, { run_id: initial.run_id, step: initial.step })
    expect(await scan(t)).toEqual(advanced)
    vi.setSystemTime(NOW + 11 * 60_000)
    await t.mutation(sample, {})
    expect((await scan(t))?.run_id).toBe(initial.run_id)
    const report = await finishSample(t)
    expect(report.storageDaily[0].samples).toBe(1)
  })

  it('restarts an over-age partial scan and ignores deliveries belonging to the old run', async () => {
    const t = newT()
    await t.mutation(sample, {})
    const initial = (await scan(t))!
    vi.setSystemTime(NOW + 3 * 60 * 60_000)
    await t.mutation(sample, {})
    const replacement = (await scan(t))!
    expect(replacement.run_id).not.toBe(initial.run_id)
    await t.mutation(samplePage, { run_id: initial.run_id, step: initial.step })
    expect(await scan(t)).toEqual(replacement)
    expect((await finishSample(t)).storageDaily[0].samples).toBe(1)
  })

  it('retains sample sums for monthly averages and lifetime counts after daily history expires', async () => {
    const t = newT()
    const old = await receipt(t)
    await t.run(async (ctx) => {
      await recordDemoCreated(ctx, old._id)
      await recordStorageSample(ctx, 100, 30)
      await recordStorageSample(ctx, 300, 10)
    })
    expect((await t.query(snapshot, {})).storageDaily).toEqual([
      { date: '2026-09-16', samples: 2, databaseBytesSum: 400, fileBytesSum: 40 },
    ])
    vi.setSystemTime(NOW + 801 * 86_400_000)
    await t.run((ctx) => recordStorageSample(ctx, 5, 1))
    const later = await t.run(demoMetricsSnapshot)
    expect(later.totalCreated).toBe(1)
    expect(later.counts).toHaveLength(1)
    expect(later.counts[0].created).toBe(0)
    expect(later.historyCompleteSince).toBe(Date.parse(`${retainedSince(Date.now())}T00:00:00Z`))
    expect(await t.run((ctx) => ctx.db.query('demo_metrics_daily').collect())).toHaveLength(1)
  })
})
