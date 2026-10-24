/* Which cron jobs a deployment registers (crons.ts). Convex reads the
 * module when functions are pushed, so each case imports it afresh under one
 * QIVO_ENVIRONMENT. The expected jobs come from the module's own source, so a
 * job added there is covered here without editing this file. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../crons.ts?raw'

/** The job names crons.ts registers, read from its `crons.<schedule>('name'` calls. */
const declared = [...source.matchAll(/\bcrons\.\w+\(\s*'([^']+)'/g)].map((m) => m[1])

/** The app's modules, loaded on demand, keyed by their path from this file. */
const modules = import.meta.glob<Record<string, { isMutation?: true; isAction?: true }>>([
  '../**/*.ts',
  '!../_generated/**',
  '!../betterAuth/**',
  '!../tests/**',
])

/** The jobs the module exports when Convex reads it under `environment`. */
async function jobs(environment: string | undefined) {
  vi.stubEnv('QIVO_ENVIRONMENT', environment)
  vi.resetModules()
  return (await import('../crons')).default.crons
}

afterEach(() => vi.unstubAllEnvs())

describe('cron jobs per deployment', () => {
  it('reads every job out of crons.ts', () => {
    expect(declared.length).toBeGreaterThan(0)
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('registers every job outside a branch preview, a missing or unknown value included', async () => {
    for (const environment of [
      'production',
      'staging',
      'development',
      'demo',
      undefined,
      '',
      'Preview',
      'unknown',
    ])
      expect(Object.keys(await jobs(environment)), String(environment)).toEqual(declared)
  })

  it('registers no job on a branch preview', async () => {
    expect(Object.keys(await jobs('preview'))).toEqual([])
  })

  /* Convex refuses a push whose job names a missing function or a query.
     Branch previews push no job, so this is the check before staging. */
  it('schedules only mutations and actions that exist', async () => {
    for (const job of Object.values(await jobs('production'))) {
      const [module, name = 'default'] = job.name.split(':')
      const load = modules[`../${module}.ts`]
      expect(load, job.name).toBeDefined()
      const target = (await load())[name]
      expect(Boolean(target?.isMutation || target?.isAction), job.name).toBe(true)
    }
  })
})
